import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import {
  loadStudioToml,
  type TomlTable,
} from "@bnbagent/studio-runtime/config";
import {
  ensureAltanaSessionLoaded,
  ensureKeystoreMaterialized,
  ensureTwakMaterialized,
  getWallet,
} from "@bnbagent/studio-runtime/wallet";
import {
  createEnvelopeMiddleware,
  b402SellPath,
  type B402HttpRequest,
  type B402RunWork,
  B402Seller,
} from "@bnbagent/studio-runtime/b402";
import express from "express";
import { buildAgentCard } from "./agentCard.js";
import { SellerAgentExecutor } from "./executor.js";
import {
  loadOAuthConfig,
  oauthTokenHandler,
  requireOAuth,
} from "./oauth.js";
import { analyzeYieldScoutText } from "./yieldScout.js";
import { requestLimitContext } from "./requestLimits.js";
import type { RunWork } from "./sellerCore.js";

const APP_NAME = "agent";

function generatorTag(): string {
  let name = "";
  try {
    const cfg = loadStudioToml();
    name = String(((cfg.project ?? {}) as Record<string, unknown>).name ?? "");
  } catch {

    return APP_NAME;
  }
  return name.endsWith("-agent")
    ? name.slice(0, -"-agent".length)
    : name || APP_NAME;
}

async function loadRuntimeSecrets(): Promise<void> {
  const secretId = process.env.BNBAGENT_RUNTIME_SECRET_ID;
  if (!secretId) {
    return;
  }
  const resp = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const bundle = JSON.parse(resp.SecretString ?? "{}") as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(bundle)) {
    process.env[key] = String(value);
  }
  const pieverseKey = process.env.PIEVERSE_LLM_API_KEY;
  if (pieverseKey) {
    const fingerprint = createHash("sha256")
      .update(pieverseKey, "utf-8")
      .digest("hex")
      .slice(0, 12);
    console.info(
      `[runtime-secrets] PIEVERSE_LLM_API_KEY source=secretsmanager sha256=${fingerprint}…`,
    );
  }
}

function defaultNetwork(): string {
  try {
    const cfg = loadStudioToml();
    return String(
      ((cfg.network ?? {}) as Record<string, unknown>).default ?? "bsc-testnet",
    );
  } catch {
    return "bsc-testnet";
  }
}

export function buildRunWork(): RunWork {
  return async (prompt) => analyzeYieldScoutText(prompt);
}

function hasErc8183Rail(cfg: TomlTable): boolean {
  const payments = asTable(cfg.payments);
  return asTable(payments?.erc8183) !== null;
}

function asTable(value: unknown): TomlTable | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : null;
}

function flatHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") out[name] = value;
    else if (value !== undefined) out[name] = value[0] ?? "";
  }
  return out;
}

function flatQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

function b402Work(runWork: RunWork): B402RunWork {
  return ({ prompt }) => runWork(prompt, { sessionId: "b402" });
}

export class SkillRouter {
  readonly name: string;
  readonly description =
    "ERC-8183 seller agent (negotiate + notify_funded) over A2A.";
  private readonly executor: SellerAgentExecutor;

  constructor(executor: SellerAgentExecutor, opts: { name?: string } = {}) {
    this.executor = executor;
    this.name = opts.name ?? "seller_agent";
  }

  async run(text: string | null | undefined): Promise<string> {
    const envelope = extractEnvelope(text);
    const result =
      envelope === null
        ? {
            error:
              'expected a JSON skill envelope, e.g. {"skill": "negotiate", ...}',
            skills: ["negotiate", "notify_funded"],
          }
        : await this.executor.dispatch(envelope);
    return JSON.stringify(result);
  }
}

export function extractEnvelope(
  text: string | null | undefined,
): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  return obj !== null && typeof obj === "object" && !Array.isArray(obj)
    ? (obj as Record<string, unknown>)
    : null;
}

export function responsesInputText(input: unknown): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return null;
  }
  const texts: string[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      texts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part && typeof part === "object") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  return texts.at(-1) ?? null;
}

function responseId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function responseEnvelope(text: string, model: string) {
  const responseIdValue = responseId("resp");
  const messageId = responseId("msg");
  const part = { type: "output_text", annotations: [], logprobs: [], text };
  const item = {
    id: messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [part],
  };
  return {
    id: responseIdValue,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [item],
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    metadata: {},
  };
}

function sendStreamingResponse(
  res: express.Response,
  response: ReturnType<typeof responseEnvelope>,
): void {
  const item = response.output[0];
  const part = item.content[0];
  const events = [
    { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 2, output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", sequence_number: 3, output_index: 0, item_id: item.id, content_index: 0, delta: part.text },
    { type: "response.output_text.done", sequence_number: 4, output_index: 0, item_id: item.id, content_index: 0, text: part.text },
    { type: "response.content_part.done", sequence_number: 5, output_index: 0, item_id: item.id, content_index: 0, part },
    { type: "response.output_item.done", sequence_number: 6, output_index: 0, item },
    { type: "response.completed", sequence_number: 7, response },
  ];
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

async function main(): Promise<void> {
  await loadRuntimeSecrets();

  ensureKeystoreMaterialized();
  ensureTwakMaterialized();
  await ensureAltanaSessionLoaded();

  const cfg = loadStudioToml();
  const oauth = loadOAuthConfig(process.env);
  const rails = { erc8183: hasErc8183Rail(cfg) };
  const sellPath = b402SellPath(cfg);
  const host = process.env.AGENT_BIND_HOST || "0.0.0.0";

  const override = Number(process.env.AGENT_PORT || process.env.PORT || "");
  const ports = [
    ...new Set([
      ...(Number.isInteger(override) && override > 0 ? [override] : []),
      9000,
      8088,
    ]),
  ];
  const port = ports[0] as number;
  const runWork = buildRunWork();

  const executor = new SellerAgentExecutor({
    runWork,
    generator: generatorTag(),
    network: defaultNetwork(),
    commerceSkills: rails.erc8183,
  });
  const agentCard = buildAgentCard({ commerceSkills: rails.erc8183 });
  const seller = await B402Seller.create({
    cfg,
    runWork: b402Work(runWork),
    walletAddress: getWallet().address,

    resourceUrl: `${
      process.env.BNBAGENT_PUBLIC_URL ??
      process.env.AGENT_PUBLIC_URL ??
      process.env.AGENTCORE_RUNTIME_URL ??
      `http://localhost:${port}`
    }${sellPath}`,
  });
  const router = new SkillRouter(executor, { name: generatorTag() });

  const handler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor,
  );

  const app = express();
  app.use(requestLimitContext);

  app.get("/ping", (_req, res) => {
    res.json({ status: executor.isBusy() ? "HEALTHY_BUSY" : "HEALTHY" });
  });

  app.get("/readiness", (_req, res) => {
    res.json({ status: "READY" });
  });

  if (oauth !== null) {
    app.post(
      "/oauth/token",
      express.urlencoded({ extended: false, limit: "16kb" }),
      oauthTokenHandler(oauth),
    );
  }

  if (seller.state !== "disabled") {
    app.all(
      sellPath,
      express.text({ type: "*/*", limit: "1mb" }),
      async (req, res) => {
        const request: B402HttpRequest = {
          method: req.method,
          path: req.path,
          query: flatQuery(req.query),
          headers: flatHeaders(req.headers),
          body:
            typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body ?? ""),
        };
        const out = await seller.handle(request);
        res.status(out.status).set(out.headers).send(out.body);
      },
    );
  }

  app.use(express.json({ limit: "8mb" }));
  app.use(createEnvelopeMiddleware({ port }));
  if (oauth !== null) app.use(requireOAuth(oauth));

  app.post("/invocations", async (req, res) => {
    const input = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof input.input === "string" ? input.input : null;
    res.json({ output: await router.run(text) });
  });

  app.post("/responses", async (req, res) => {
    const input = (req.body ?? {}) as Record<string, unknown>;
    const output = await router.run(responsesInputText(input.input));
    const response = responseEnvelope(
      output,
      typeof input.model === "string" ? input.model : APP_NAME,
    );
    if (input.stream === true) {
      sendStreamingResponse(res, response);
    } else {
      res.json(response);
    }
  });

  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );
  app.use(
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  const servers = ports.map((p, i) => {
    const server = app.listen(p, host, () => {
      console.log(
        `[seller-agent] serving on ${host}:${p}${i === 0 ? "" : " (secondary contract port)"} (${seller.protocol}: ${seller.state})`,
      );
    });
    if (i > 0) {
      server.on("error", (e) => {
        console.warn(
          `[seller-agent] secondary contract port ${p} unavailable: ${(e as Error).message}`,
        );
      });
    }
    return server;
  });
  process.once("SIGTERM", () => {
    let open = servers.length;
    for (const server of servers) {
      server.close(() => {
        open -= 1;
        if (open === 0) process.exit(0);
      });
    }
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("[seller-agent] fatal:", e);
    process.exit(1);
  });
}
