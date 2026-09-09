import { ERC8183JobOps } from "@bnbagent/sdk/erc8183";
import { SubmitPermanentlyUnsupportedError } from "@bnbagent/studio-runtime/erc8183";
import { getWallet } from "@bnbagent/studio-runtime/wallet";
import { limitCommerceOperation } from "./requestLimits.js";
import * as defaultSigning from "./signing.js";

const log = {
  info: (msg: string) => console.info(`[seller-agent.core] ${msg}`),
  warn: (msg: string) => console.warn(`[seller-agent.core] WARNING ${msg}`),
  error: (msg: string, e?: unknown) =>
    console.error(`[seller-agent.core] ERROR ${msg}`, e ?? ""),
};

function envSeconds(name: string, dflt: number): number {
  const v = Number(process.env[name] || dflt);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const jobDeliveryTimeoutSeconds = () =>
  envSeconds("NOTIFY_DELIVERY_TIMEOUT_SECONDS", 600);
const sweepTimeoutSeconds = () => envSeconds("NOTIFY_SWEEP_TIMEOUT_SECONDS", 60);
const preverifyTimeoutSeconds = () =>
  envSeconds("NOTIFY_PREVERIFY_TIMEOUT_SECONDS", 30);

export class DeliveryTimeoutError extends Error {}

async function withTimeout<T>(
  work: Promise<T>,
  seconds: number,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new DeliveryTimeoutError(`timed out after ${seconds}s`));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type RunWork = (
  prompt: string,
  opts: { sessionId: string; abortSignal?: AbortSignal },
) => Promise<string>;

export interface SigningApi {
  listPrice(): bigint;
  clampPrice(proposedWei: bigint): bigint;
  signQuote(
    request: Record<string, unknown>,
    clampedPriceWei: bigint,
  ): Promise<Record<string, unknown>>;
  verifySignedJob(
    jobId: number,
  ): Promise<{ ok: boolean; reason: string; permanent: boolean }>;
  jobSpec(
    jobId: number,
  ): Promise<{ task: string; terms: Record<string, unknown> } | null>;
  submitResult(
    jobId: number,
    responseContent: string,
    metadata?: Record<string, unknown> | null,
  ): Promise<{ submitTx: string; deliverableUrl: string | null }>;
}

export type PendingJobsFetcher = (
  network: string,
) => Promise<Record<string, unknown>>;

const defaultPendingJobs: PendingJobsFetcher = async (network) => {
  const ops = await ERC8183JobOps.create({
    walletProvider: getWallet(),
    network,
  });
  return (await ops.getPendingJobs()) as Record<string, unknown>;
};

export interface SellerCoreOpts {
  runWork: RunWork;
  generator: string;
  network?: string | null;

  commerceSkills?: boolean;

  signing?: SigningApi;

  pendingJobs?: PendingJobsFetcher;
}

export class SellerCore {
  protected readonly runWork: RunWork;
  protected readonly generator: string;
  protected readonly network: string;
  protected readonly signing: SigningApi;
  private readonly commerceSkills: boolean;
  private readonly pendingJobs: PendingJobsFetcher;

  private readonly tasks = new Set<Promise<void>>();
  private readonly inflight = new Set<number>();

  constructor(opts: SellerCoreOpts) {
    this.runWork = opts.runWork;
    this.generator = opts.generator;
    this.network = opts.network ?? "bsc-testnet";
    this.signing = opts.signing ?? defaultSigning;
    this.commerceSkills = opts.commerceSkills ?? true;
    this.pendingJobs = opts.pendingJobs ?? defaultPendingJobs;
  }

  isBusy(): boolean {
    return this.tasks.size > 0;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  async negotiate(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requireCommerceRail();
    await limitCommerceOperation("negotiate");
    let request = data.request;
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      const picked: Record<string, unknown> = {};
      for (const k of ["task_description", "terms"]) {
        if (k in data) picked[k] = data[k];
      }
      request = picked;
    }
    const clamped = this.signing.clampPrice(this.signing.listPrice());
    return this.signing.signQuote(request as Record<string, unknown>, clamped);
  }

  skills(): string[] {
    return this.commerceSkills ? ["negotiate", "notify_funded"] : [];
  }

  async notifyFunded(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requireCommerceRail();
    await limitCommerceOperation("notify_funded");
    const raw = data.job_id;
    if (raw === undefined || raw === null || String(raw) === "") {
      this.spawn(() => this.sweep());
      return {
        status: "accepted",
        note: "no job_id — scanning funded jobs in the background; poll the chain for results",
      };
    }
    let jobId: number;
    try {
      jobId = parseJobId(raw);
    } catch {
      return { status: "rejected", error: `invalid job_id: ${JSON.stringify(raw)}` };
    }
    let verified = false;
    try {

      const v = await withTimeout(
        this.signing.verifySignedJob(jobId),
        preverifyTimeoutSeconds(),
      );
      if (!v.ok && v.permanent) {
        return { status: "rejected", job_id: jobId, reason: v.reason };
      }
      verified = v.ok;
    } catch (e) {

      log.warn(
        `pre-verify of job ${jobId} failed (${e instanceof Error ? e.message : e}); accepting, will re-verify in background`,
      );
    }
    this.spawnJob(jobId, { verified });
    this.spawn(() => this.sweep());
    return {
      status: "accepted",
      job_id: jobId,
      note: "delivery started; poll the chain (SUBMITTED / get_deliverable_url) for the result",
    };
  }

  protected spawn(work: () => Promise<void>): void {
    const task = work().catch((e) => {

      log.error("background task failed", e);
    });
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
  }

  private spawnJob(jobId: number, opts: { verified: boolean }): void {
    if (this.inflight.has(jobId)) return;
    this.inflight.add(jobId);
    this.spawn(() => this.runJob(jobId, opts));
  }

  private async runJob(
    jobId: number,
    { verified }: { verified: boolean },
  ): Promise<void> {
    let terminal = false;
    const controller = new AbortController();
    try {

      const result = await withTimeout(
        verified
          ? this.doWorkAndSubmit(jobId, controller.signal)
          : this.fulfillJob(jobId, controller.signal),
        jobDeliveryTimeoutSeconds(),
        controller,
      );
      log.info(`notify_funded job ${jobId} → ${JSON.stringify(result)}`);

      terminal = Boolean(result.ok || result.skip);
    } catch (e) {
      if (e instanceof DeliveryTimeoutError) {

        log.warn(
          `background delivery of job ${jobId} timed out after ${jobDeliveryTimeoutSeconds()}s; will retry`,
        );
      } else {
        log.error(`background delivery of job ${jobId} failed`, e);
      }
    } finally {
      if (!terminal) {
        this.inflight.delete(jobId);
      }
    }
  }

  private requireCommerceRail(): void {
    if (!this.commerceSkills) {
      throw new Error("8183 rail disabled");
    }
  }

  private async fulfillJob(
    jobId: number,
    abortSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const v = await this.signing.verifySignedJob(jobId);
    if (!v.ok) {
      return { ok: false, job_id: jobId, skip: v.permanent, reason: v.reason };
    }
    return this.doWorkAndSubmit(jobId, abortSignal);
  }

  protected async doWorkAndSubmit(
    jobId: number,
    abortSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const spec = await this.signing.jobSpec(jobId);
    const task = spec?.task ?? "";
    const work = await this.runWork(task, {
      sessionId: String(jobId),
      abortSignal,
    });

    let res: { submitTx: string; deliverableUrl: string | null };
    try {
      res = await this.signing.submitResult(jobId, work, {
        job_id: jobId,
        generator: this.generator,
        built_with: "https://github.com/bnb-chain/bnbagent-studio",
      });
    } catch (e) {
      if (
        e instanceof SubmitPermanentlyUnsupportedError ||
        (e instanceof Error && e.name === "SubmitPermanentlyUnsupportedError")
      ) {

        return { ok: false, job_id: jobId, skip: true, reason: e.message };
      }
      throw e;
    }
    return {
      ok: true,
      job_id: jobId,
      tx_hash: res.submitTx,
      deliverable_url: res.deliverableUrl,
    };
  }

  private async sweep(): Promise<void> {
    let pending: Record<string, unknown>;
    try {

      pending = await withTimeout(
        this.pendingJobs(this.network),
        sweepTimeoutSeconds(),
      );
    } catch (e) {

      log.warn(`funded-job sweep failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const jobs = Array.isArray(pending?.jobs) ? pending.jobs : [];
    for (const job of jobs) {
      const jid =
        job !== null && typeof job === "object" && !Array.isArray(job)
          ? (job as Record<string, unknown>).jobId
          : undefined;
      if (jid === undefined || jid === null) continue;
      try {
        this.spawnJob(parseJobId(jid), { verified: false });
      } catch {

      }
    }
  }
}

export function parseJobId(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") return Number(raw);

  return Number(BigInt(String(raw).trim()));
}
