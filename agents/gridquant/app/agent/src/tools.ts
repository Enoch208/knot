import * as cr from "@bnbagent/studio-runtime/tools";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

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

const networkArg = z
  .string()
  .optional()
  .describe("studio network name (defaults to the project's [network].default)");

export const LLM_READ_TOOLS: ToolSet = {

  wallet_info: tool({
    description:
      "Describe the agent's active wallet (address, kind, key location).",
    inputSchema: z.object({}),
    execute: async () => cr.walletInfo(),
  }),
  balance_native: tool({
    description:
      "Native BNB balance of an address (defaults to the agent's own wallet).",
    inputSchema: z.object({
      address: z.string().optional().describe("0x address; omit for own wallet"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.balanceNative(address ?? null, network ?? defaultNetwork()),
  }),
  balance_u: tool({

    description:
      "$U (payment token) balance of an address (defaults to the agent's own wallet).",
    inputSchema: z.object({
      address: z.string().optional().describe("0x address; omit for own wallet"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.balanceU(address ?? null, network ?? defaultNetwork()),
  }),
  network_info: tool({
    description: "Chain id / RPC / token info for a studio network.",
    inputSchema: z.object({ network: networkArg }),
    execute: async ({ network }) => cr.networkInfo(network ?? defaultNetwork()),
  }),
  tx_status: tool({
    description: "Status + receipt summary of a transaction hash.",
    inputSchema: z.object({
      tx_hash: z.string().describe("0x transaction hash"),
      network: networkArg,
    }),
    execute: async ({ tx_hash, network }) =>
      cr.txStatus(tx_hash, network ?? defaultNetwork()),
  }),

  agent_info: tool({

    description: "ERC-8004 identity record for an agent id.",
    inputSchema: z.object({
      agent_id: z.number().int().describe("ERC-8004 agent id"),
      network: networkArg,
    }),
    execute: async ({ agent_id, network }) =>
      cr.agentInfo(agent_id, network ?? defaultNetwork()),
  }),
  agent_by_address: tool({

    description: "Look up an ERC-8004 agent registration by wallet address.",
    inputSchema: z.object({
      address: z.string().describe("0x wallet address"),
      network: networkArg,
    }),
    execute: async ({ address, network }) =>
      cr.agentByAddress(address, network ?? defaultNetwork()),
  }),

  job_status: tool({

    description: "Read-only ERC-8183 job summary (status, budget, deliverable URL).",
    inputSchema: z.object({
      job_id: z.number().int().describe("on-chain job id"),
      network: networkArg,
    }),
    execute: async ({ job_id, network }) =>
      cr.jobStatus(job_id, network ?? defaultNetwork()),
  }),
  job_list: tool({

    description: "List recent ERC-8183 jobs (optionally only this agent's).",
    inputSchema: z.object({
      limit: z.number().int().optional(),
      mine: z.boolean().optional().describe("only jobs assigned to this agent"),
      network: networkArg,
    }),
    execute: async ({ limit, mine, network }) =>
      cr.jobList({ limit, mine, network: network ?? defaultNetwork() }),
  }),

};
