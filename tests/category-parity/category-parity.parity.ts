import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ParseResult {
  success: boolean;
  data?: unknown;
}

interface StrictSchema {
  safeParse(value: unknown): ParseResult;
}

interface SellerSpec {
  name: string;
  analyzerFile: string;
  analyzerExport: string;
  schemaFile: string;
  requestSchemaExport: string;
  artifactSchemaExport: string;
  fixtureFile: string;
  fixtureExport: string;
  fundedDeliveryTest: string;
  requestExecution(request: Record<string, unknown>): void;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sellers: SellerSpec[] = [
  {
    name: "healthguard",
    analyzerFile: "healthGuard.ts",
    analyzerExport: "analyzeHealthGuardText",
    schemaFile: "healthSchemas.ts",
    requestSchemaExport: "healthGuardRequest",
    artifactSchemaExport: "healthGuardArtifact",
    fixtureFile: "healthFixture.ts",
    fixtureExport: "healthFixture",
    fundedDeliveryTest: "sellerCore.health.test.ts",
    requestExecution: (request) => {
      const task = asRecord(request.task);
      const constraints = asRecord(task.constraints);
      task.capability = "execution";
      task.executionChainId = 56;
      constraints.mode = "execute";
    },
  },
  {
    name: "rangepilot",
    analyzerFile: "rangePilot.ts",
    analyzerExport: "analyzeRangePilotText",
    schemaFile: "rangeSchemas.ts",
    requestSchemaExport: "rangePilotRequest",
    artifactSchemaExport: "rangePilotArtifact",
    fixtureFile: "rangeFixture.ts",
    fixtureExport: "rangeFixture",
    fundedDeliveryTest: "sellerCore.range.test.ts",
    requestExecution: (request) => {
      const task = asRecord(request.task);
      const constraints = asRecord(task.constraints);
      task.capability = "execution";
      constraints.executionMode = "unattended";
    },
  },
  {
    name: "gridquant",
    analyzerFile: "gridQuant.ts",
    analyzerExport: "analyzeGridQuantText",
    schemaFile: "gridSchemas.ts",
    requestSchemaExport: "gridQuantRequest",
    artifactSchemaExport: "gridQuantArtifact",
    fixtureFile: "gridFixture.ts",
    fixtureExport: "gridFixture",
    fundedDeliveryTest: "sellerCore.grid.test.ts",
    requestExecution: (request) => {
      const task = asRecord(request.task);
      const parameters = asRecord(task.parameters);
      task.capability = "execution";
      parameters.executionMode = "conditional-swaps";
    },
  },
  {
    name: "yieldscout",
    analyzerFile: "yieldScout.ts",
    analyzerExport: "analyzeYieldScoutText",
    schemaFile: "yieldSchemas.ts",
    requestSchemaExport: "yieldScoutRequest",
    artifactSchemaExport: "yieldScoutArtifact",
    fixtureFile: "yieldFixture.ts",
    fixtureExport: "yieldFixture",
    fundedDeliveryTest: "sellerCore.yield.test.ts",
    requestExecution: (request) => {
      request.capability = "execution";
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function moduleAt(path: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path).href) as Promise<Record<string, unknown>>;
}

function callable(module: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const value = module[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as (...args: unknown[]) => unknown;
}

function schema(module: Record<string, unknown>, name: string): StrictSchema {
  const value = asRecord(module[name]);
  assert.equal(typeof value.safeParse, "function", `${name} must be a schema`);
  return value as unknown as StrictSchema;
}

function tomlTable(source: string, tableName: string): Record<string, string> {
  const values: Record<string, string> = {};
  let activeTable = "";
  for (const rawLine of source.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    const table = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (table !== null) {
      activeTable = table[1] ?? "";
      continue;
    }
    if (activeTable !== tableName) continue;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (assignment !== null && assignment[1] !== undefined && assignment[2] !== undefined) {
      values[assignment[1]] = assignment[2].trim();
    }
  }
  return values;
}

function stripTomlComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && quoted) {
      escaped = !escaped;
      continue;
    }
    if (character === '"' && !escaped) quoted = !quoted;
    if (character === "#" && !quoted) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function tomlString(value: string | undefined): string {
  assert.notEqual(value, undefined);
  const parsed: unknown = JSON.parse(value as string);
  assert.equal(typeof parsed, "string");
  return parsed as string;
}

function tomlStrings(value: string | undefined): string[] {
  assert.notEqual(value, undefined);
  const parsed: unknown = JSON.parse(value as string);
  assert(Array.isArray(parsed) && parsed.every((item) => typeof item === "string"));
  return parsed;
}

for (const seller of sellers) {
  test(`${seller.name} satisfies category seller parity`, async () => {
    const agentDirectory = resolve(root, "agents", seller.name, "app", "agent");
    const [analyzerModule, schemaModule, fixtureModule, cardModule, configSource, packageSource] =
      await Promise.all([
        moduleAt(resolve(agentDirectory, "src", seller.analyzerFile)),
        moduleAt(resolve(agentDirectory, "src", seller.schemaFile)),
        moduleAt(resolve(agentDirectory, "tests", seller.fixtureFile)),
        moduleAt(resolve(agentDirectory, "src", "agentCard.ts")),
        readFile(resolve(agentDirectory, "studio.toml"), "utf8"),
        readFile(resolve(agentDirectory, "package.json"), "utf8"),
      ]);
    const buildCard = callable(cardModule, "buildAgentCard");
    const analyze = callable(analyzerModule, seller.analyzerExport);
    const encode = callable(analyzerModule, "encodeSignedTaskTransport");
    const createFixture = callable(fixtureModule, seller.fixtureExport);
    const evaluationTime = fixtureModule.NOW;
    assert(evaluationTime instanceof Date);
    const requestSchema = schema(schemaModule, seller.requestSchemaExport);
    const artifactSchema = schema(schemaModule, seller.artifactSchemaExport);
    const request = asRecord(createFixture());
    const parsedRequest = requestSchema.safeParse(request);
    assert.equal(parsedRequest.success, true);
    assert.equal(requestSchema.safeParse({ ...request, unexpected: true }).success, false);
    const task = "task" in request ? asRecord(request.task) : request;
    const snapshot = asRecord(request.snapshot);
    assert.equal(task.capability, "analysis");
    assert.equal(task.dataChainId ?? task.chainId, 56);
    assert.equal(snapshot.chainId, 56);
    if ("identityChainId" in task) assert.equal(task.identityChainId, 97);
    if ("paymentChainId" in task) assert.equal(task.paymentChainId, 97);
    const encoded = encode(JSON.stringify(request));
    assert.equal(typeof encoded, "string");
    assert.match(encoded as string, /^knot-json-base64url\/1:[A-Za-z0-9_-]+$/);
    const artifact = asRecord(JSON.parse(String(analyze(encoded, evaluationTime))));
    assert.equal(artifactSchema.safeParse(artifact).success, true);
    assert.equal(artifactSchema.safeParse({ ...artifact, unexpected: true }).success, false);
    assert.equal(artifact.capability, "analysis");
    assert.equal(asRecord(artifact.evidence ?? artifact.snapshot).chainId, 56);
    const executionRequest = structuredClone(request);
    seller.requestExecution(executionRequest);
    const refusal = asRecord(
      JSON.parse(String(analyze(encode(JSON.stringify(executionRequest)), evaluationTime))),
    );
    assert.equal(artifactSchema.safeParse(refusal).success, true);
    assert.equal(refusal.capability, "analysis");
    assert.notEqual(refusal.status, artifact.status);
    const card = asRecord(buildCard());
    const skills = card.skills;
    assert(Array.isArray(skills));
    assert.deepEqual(
      skills.map((item) => asRecord(item).id).sort(),
      ["negotiate", "notify_funded"],
    );
    const stack = tomlTable(configSource, "stack");
    const network = tomlTable(configSource, "network");
    const payment = tomlTable(configSource, "payments.erc8183");
    assert(tomlStrings(stack.protocols).includes("A2A"));
    assert.equal(tomlString(network.default), "bsc-testnet");
    const price = BigInt(tomlString(payment.price));
    assert(price > 0n);
    assert.equal(BigInt(tomlString(payment.max_price)), price);
    assert(BigInt(tomlString(payment.min_price)) <= price);
    assert.match(tomlString(payment.currency), /^0x[0-9a-fA-F]{40}$/);
    const packageJson = asRecord(JSON.parse(packageSource));
    const scripts = asRecord(packageJson.scripts);
    assert.equal(typeof scripts.build, "string");
    assert.equal(typeof scripts.test, "string");
    assert.match(String(scripts.test), /tests\/\*\*\/\*\.test\.ts/);
    await readFile(resolve(agentDirectory, "tests", seller.fundedDeliveryTest), "utf8");
  });
}
