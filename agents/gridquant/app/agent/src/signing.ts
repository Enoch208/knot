import {
  JobDescription,
  NegotiationHandler,
  type NegotiationResult,
  type QuoteSigner,
} from "@bnbagent/sdk/erc8183";
import {
  loadStudioToml,
  type TomlTable,
} from "@bnbagent/studio-runtime/config";
import {
  erc8183Network,
  get8183Client,
  settleWorkflow,
  type SubmitResult,
  submitWorkflow,
  type Verdict,
  verifySignedJob as verifySignedJobCore,
} from "@bnbagent/studio-runtime/erc8183";
import { getWallet } from "@bnbagent/studio-runtime/wallet";

const MAX_UINT256 = (1n << 256n) - 1n;

type StudioTomlLoader = () => TomlTable;
const defaultTomlLoader: StudioTomlLoader = () => loadStudioToml();
let tomlLoader: StudioTomlLoader = defaultTomlLoader;

export function _setStudioTomlLoader(loader: StudioTomlLoader | null): void {
  tomlLoader = loader ?? defaultTomlLoader;
  handler = null;
}

export interface NegotiationHandlerLike {
  negotiate(
    request: Record<string, unknown>,
    opts?: { price?: string; estimatedCompletionSeconds?: number },
  ): Promise<NegotiationResult> | NegotiationResult;
}

let handler: NegotiationHandlerLike | null = null;

type RuntimeWallet = ReturnType<typeof getWallet>;
type SessionQuoteWallet = RuntimeWallet & {
  sessionQuoteSigner(): QuoteSigner;
};

export function negotiationSignerOptions(
  wallet: RuntimeWallet,
): { quoteSigner: QuoteSigner } | { walletProvider: RuntimeWallet } {
  const candidate = wallet as Partial<SessionQuoteWallet>;
  return typeof candidate.sessionQuoteSigner === "function"
    ? { quoteSigner: candidate.sessionQuoteSigner.call(wallet) }
    : { walletProvider: wallet };
}

export function _setNegotiationHandler(h: NegotiationHandlerLike | null): void {
  handler = h;
}

function erc8183Cfg(): Record<string, unknown> {
  let cfg: TomlTable;
  try {
    cfg = tomlLoader();
  } catch {

    cfg = {};
  }
  const payments = (cfg.payments ?? {}) as Record<string, unknown>;
  return (payments.erc8183 ?? {}) as Record<string, unknown>;
}

function defaultNetworkName(): string {
  let cfg: TomlTable;
  try {
    cfg = tomlLoader();
  } catch {
    cfg = {};
  }
  return String(((cfg.network ?? {}) as TomlTable).default ?? "bsc-testnet");
}

export function commerceVerifyingContract(
  networkName: string,
): `0x${string}` {
  return erc8183Network(networkName).commerceContract as `0x${string}`;
}

export function priceBounds(): [bigint, bigint] {
  const cfg = erc8183Cfg();

  const raw = (key: string, dflt: bigint): bigint => {
    const s = String(cfg[key] ?? "").trim();
    return s ? BigInt(s) : dflt;
  };
  return [raw("min_price", 0n), raw("max_price", MAX_UINT256)];
}

export function listPrice(): bigint {
  const s = String(erc8183Cfg().price ?? "").trim();
  return s ? BigInt(s) : 0n;
}

export function clampPrice(proposedWei: bigint): bigint {
  const [lo, hi] = priceBounds();
  const capped = proposedWei < hi ? proposedWei : hi;
  return capped > lo ? capped : lo;
}

function getHandler(): NegotiationHandlerLike {
  if (handler === null) {
    const cfg = erc8183Cfg();
    const currency = String(cfg.currency ?? "");
    const ttl = Number(cfg.quote_ttl_seconds ?? 900);
    const est = Number(cfg.default_estimated_completion_seconds ?? 600);
    const networkName = defaultNetworkName();
    const network = erc8183Network(networkName);
    const wallet = getWallet();
    handler = new NegotiationHandler({
      servicePrice: "0",
      currency,
      estimatedCompletionSeconds: est,
      ...negotiationSignerOptions(wallet),
      quoteTtlSeconds: ttl,
      chainId: network.chainId,
      verifyingContract: network.commerceContract as `0x${string}`,
    });
  }
  return handler;
}

export async function signQuote(
  request: Record<string, unknown>,
  clampedPriceWei: bigint,
): Promise<Record<string, unknown>> {

  commerceVerifyingContract(defaultNetworkName());
  const cfg = erc8183Cfg();
  const est = Number(cfg.default_estimated_completion_seconds ?? 600);

  const result = await getHandler().negotiate(request, {
    price: String(clampedPriceWei),
    estimatedCompletionSeconds: est,
  });

  if (result.accepted && (!result.negotiationHash || !result.providerSig)) {
    throw new Error(
      "quote accepted but provider_sig is missing (wallet sign failed); " +
        "refusing to relay an unsigned offer",
    );
  }

  return result.toDict();
}

export async function verifySignedJob(jobId: number): Promise<Verdict> {
  return verifySignedJobCore(jobId, getWallet().address);
}

export async function jobSpec(jobId: number): Promise<JobDescription | null> {
  const client = await get8183Client();
  const job = await client.getJob(BigInt(jobId));
  return JobDescription.fromStr(job.description);
}

export async function submitResult(
  jobId: number,
  responseContent: string,
  metadata?: Record<string, unknown> | null,
): Promise<SubmitResult> {
  return submitWorkflow(jobId, responseContent, { metadata: metadata ?? null });
}

export async function settle(jobId: number): Promise<string> {
  return settleWorkflow(jobId, { action: "approve" });
}
