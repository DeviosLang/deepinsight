export {
  propagateRisk,
  computeInitialRisk,
  prioritizeCallers,
  riskToLevel,
  DECAY_FACTORS,
  MIN_RISK_THRESHOLD,
  MAX_FANOUT_PER_LAYER,
  MAX_DEPTH,
  RISK_THRESHOLDS,
} from "./propagation.js";

export type {
  GetCallersFunction,
  ClassifyCallFunction,
  PropagationConfig,
} from "./propagation.js";
