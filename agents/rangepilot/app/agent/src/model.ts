import { loadStudioToml, type TomlTable } from "@bnbagent/studio-runtime/config";
import { resolveModel } from "@bnbagent/studio-runtime/llm";
import {
  BudgetPolicy,
  PieverseCreditEnsurer,
  PieversePolicy,
} from "@bnbagent/studio-runtime/pieverse";
import { getWallet } from "@bnbagent/studio-runtime/wallet";
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";

export function buildModel(): LanguageModel {
  const cfg = loadStudioToml();
  const llmCfg = (cfg.llm ?? {}) as TomlTable;
  const inner = resolveModel(llmCfg);

  if (String(llmCfg.provider ?? "openrouter") !== "pieverse-llm") {
    return inner;
  }

  const autoRenewCfg = (llmCfg.auto_renew ?? {}) as TomlTable;
  const pieverseCfg = (llmCfg.pieverse ?? {}) as TomlTable;
  const budgetCfg = (cfg.budget ?? {}) as TomlTable;

  const policy = PieversePolicy.fromToml(autoRenewCfg);
  if (!policy.enabled) {
    return inner;
  }

  const keyHash = pieverseCfg.key_hash;
  if (!keyHash) {
    throw new Error(
      "[llm.pieverse].key_hash is missing in studio.toml. " +
        "Run `bag llm activate` to create a Pieverse key first. " +
        "(After activate, you may need to restart the agent process " +
        "for changes to take effect.)",
    );
  }
  const networkName = String(pieverseCfg.network ?? "bsc-mainnet");
  const budgetPolicy = BudgetPolicy.fromToml(budgetCfg);

  const ensurer = new PieverseCreditEnsurer({
    modelId: String(llmCfg.model ?? ""),
    wallet: getWallet(),
    keyHash: String(keyHash),
    networkName,
    policy,
    budgetPolicy,
  });

  const creditEnsure: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate }) => {
      await ensurer.ensureCredits();
      return doGenerate();
    },
    wrapStream: async ({ doStream }) => {
      await ensurer.ensureCredits();
      return doStream();
    },
  };

  return wrapLanguageModel({
    model: inner as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: creditEnsure,
  });
}
