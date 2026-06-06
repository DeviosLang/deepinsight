/**
 * DeepInsight Core — Shared Types
 */

// ─── Call Types ────────────────────────────────────────────────────────────────

export type CallType =
  | "direct_call"
  | "http_api"
  | "mq_event"
  | "config_reference"
  | "dynamic_dispatch";

// ─── Risk Levels ───────────────────────────────────────────────────────────────

export type RiskLevel = "P0" | "P1" | "P2" | "P3" | "NEEDS_HUMAN_REVIEW";

export type RiskSeverity = "critical" | "high" | "medium" | "low" | "info";

// ─── Call Node ─────────────────────────────────────────────────────────────────

export interface CallNode {
  id: string;
  repo: string;
  file: string;
  line: number;
  symbol: string;
  signature?: string;

  // Context
  isPublicApi: boolean;
  isAuthCritical: boolean;
  isPayment: boolean;
  isExportedSymbol: boolean;
  isTestHelper: boolean;
  isCriticalPath: boolean;

  // Metrics
  changeFrequency: number;
  testCoverage: number;
}

// ─── Risk Node (output of propagation) ─────────────────────────────────────────

export interface RiskNode {
  node: CallNode;
  propagatedRisk: number;
  depth: number;
  callType?: CallType;
  viaChain?: string;
  truncated?: boolean;
  belowThreshold?: boolean;
  prunedCallers?: number;
  hitCount?: number;
  annotation?: string;
}

// ─── Worker Result ─────────────────────────────────────────────────────────────

export interface WorkerResult {
  workerId: string;
  symbols: string[];
  callTreeNodes: RiskNode[];
  usage: TokenUsage;
  durationMs: number;
  verificationRounds: number;
}

// ─── Merged Result ─────────────────────────────────────────────────────────────

export interface MergedResult {
  callTree: Map<string, RiskNode>;
  riskTable: RiskNode[];
}

// ─── Analysis Task ─────────────────────────────────────────────────────────────

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface AnalysisTask {
  taskId: string;
  project: string;
  status: TaskStatus;
  changes: ChangeSpec[];
  options: AnalysisOptions;
  progress?: TaskProgress;
  result?: AnalysisResult;
  cost?: AnalysisCost;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ChangeSpec {
  repo: string;
  branch?: string;
  commit?: string;
  base?: string;
}

export interface AnalysisOptions {
  depth?: number;
  includeTestPlan?: boolean;
  mode?: "accuracy_first" | "budget_balanced";
}

export interface TaskProgress {
  step: number;
  stepName: string;
  reposScanned: number;
  reposTotal: number;
}

// ─── Analysis Result ───────────────────────────────────────────────────────────

export interface AnalysisResult {
  summary: {
    totalSymbolsChanged: number;
    affectedRepos: number;
    unaffectedRepos: number;
    riskBreakdown: Record<RiskLevel, number>;
  };
  symbols: SymbolAnalysis[];
  untrackable: string[];
  globalPatternsMatched: string[];
}

export interface SymbolAnalysis {
  name: string;
  location: string;
  diffSemantic: string;
  initialRisk: RiskSeverity;
  callTree: RiskNode[];
  riskTable: RiskTableEntry[];
  /**
   * Downstream contract checks (callee direction).
   *
   * Whereas `callTree` traces upward ("who calls me", impact radius),
   * this traces downward ("what do I call") to verify the change still
   * honours its dependencies' param/exception/transaction/schema contracts.
   * These do NOT participate in P0-P3 risk propagation; a `risk` value is
   * only assigned when the downstream path reaches a [SINK] module.
   */
  downstreamContracts?: DownstreamContract[];
  testPlan?: TestPlan[];
}

export interface DownstreamContract {
  /** Downstream callee function the changed symbol invokes */
  callee: string;
  repo: string;
  file: string;
  line: number;
  callType: CallType;
  contractKind: "param" | "exception" | "transaction" | "schema" | "other";
  status: "ok" | "violated" | "uncertain";
  /** Whether this downstream path reaches a configured [SINK] module */
  reachesSink: boolean;
  /** The [SINK] repo reached, when reachesSink is true */
  sinkRepo?: string;
  /** How the change affects this contract */
  detail: string;
  /** Risk level — only assigned when reachesSink is true */
  risk?: RiskLevel;
}

export interface RiskTableEntry {
  priority: RiskLevel;
  location: string;
  function: string;
  via: string;
  risk: RiskSeverity;
  testCoverage: "full" | "partial" | "none";
  domainContext: string;
  remediation: string;
  confidence?: number;
}

export interface TestPlan {
  target: string;
  scenario: string;
  preconditions: string[];
  testCases: TestCase[];
  observationPoints: string[];
}

export interface TestCase {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  oracle: string;
}

// ─── Cost Tracking ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
}

export interface AnalysisCost {
  taskId: string;
  project: string;
  costsByStep: {
    preFilter: { durationMs: number; reposHit: number };
    workers: WorkerCost[];
    merge: { durationMs: number };
    reporter?: { usage: TokenUsage; model: string; costUsd: number };
  };
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface WorkerCost {
  workerId: string;
  symbols: string[];
  usage: TokenUsage;
  model: string;
  costUsd: number;
  verificationRounds: number;
}

// ─── Project Config ────────────────────────────────────────────────────────────

export interface ProjectConfig {
  project: { name: string; description: string };
  repos: RepoConfig[];
  knowledgeBase?: { repo: string; paths?: string[] };
  internalPackages?: {
    prefixes?: Array<{ prefix: string; repos: string[] }>;
    explicit?: Array<{ package: string; repo: string }>;
  };
  riskPatterns: {
    highRiskDirs: string[];
    apiDirs: string[];
  };
  runtimeCalls?: {
    http?: { frameworkPatterns: string[]; routePatterns: string[] };
    mq?: {
      type: string;
      library: string;
      producerPatterns: string[];
      consumerPatterns: string[];
      namingConvention?: string;
    };
  };
  llm: {
    analysis: LlmConfig;
    utility: LlmConfig;
  };
  output?: {
    includeTestPlan?: boolean;
    includeOracle?: boolean;
    callTreeDepth?: number;
    language?: string;
  };
}

export interface RepoConfig {
  name: string;
  url: string;
  language: string;
  branch?: string;
  role?: "entry_point" | "shared_lib" | "core" | "service" | "sink";
  tags?: string[];
}

export interface LlmConfig {
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}
