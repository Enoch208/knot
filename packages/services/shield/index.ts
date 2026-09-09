export { analyzeShield, analyzeShieldText } from "./analyze.ts"
export {
  hashShieldSourceBundle,
  hashShieldSourceContent,
  shieldRules,
  ShieldCorpusError,
  verifyShieldCorpus,
} from "./corpus.ts"
export type { ShieldCorpusVerification, ShieldRules } from "./corpus.ts"
export {
  collectShieldSnapshot,
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  ShieldCollectionError,
} from "./collector.ts"
export type {
  CollectShieldSnapshotOptions,
  ShieldBlock,
  ShieldChainReader,
  ShieldCollectionErrorCode,
} from "./collector.ts"
export {
  evaluateShieldDataset,
  hashShieldArtifact,
  shieldEvaluationReport,
  shieldEvaluationRuns,
  shieldGroundTruthDataset,
  ShieldEvaluationError,
} from "./evaluate.ts"
export type {
  ShieldEvaluationReport,
  ShieldEvaluationRuns,
  ShieldGroundTruthDataset,
} from "./evaluate.ts"
export { shieldArtifact, shieldRequest, shieldRuleId } from "./schemas.ts"
export type { ShieldArtifact, ShieldFinding, ShieldRequest, ShieldSnapshot } from "./schemas.ts"
export { createBscShieldReader, ViemShieldChainReader } from "./viem-reader.ts"
