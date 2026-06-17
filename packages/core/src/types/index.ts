/**
 * DeepInsight Core — Shared Types
 *
 * Output schema: cross-repo-impact/2.0 (see docs of cross-repo-impact JSON Schema).
 *
 * Compatibility note: legacy types AnalysisResult / SymbolAnalysis / RiskTableEntry /
 * DownstreamContract (camelCase, "untrackable" string list, etc.) are kept as
 * @deprecated aliases so existing call sites still compile during the migration
 * window. The orchestrator/render layers prefer the snake_case CrossRepoImpactArtifact
 * shape; old fields are still read for backward compat but new emissions follow the
 * 2.0 schema.
 *
 * ─── §legacy-mapping ──────────────────────────────────────────────────────────
 *
 * Authoritative cross-walk between cross-repo-impact/2.0 (snake_case, current)
 * and the legacy AnalysisResult shape (camelCase, deprecated). Every fallback
 * reader in `analysis-service/src/render/markdown.ts` references this section
 * — when adding a new schema field, update the table here first, then add the
 * `pick(obj, "<new>", "<legacy>")` call at the read site.
 *
 * Most pairs are pure case-style renames; the SEMANTIC SHIFTS are the dangerous
 * ones — a legacy field name was repurposed in 2.0 to mean something different,
 * so callers must NOT treat them as interchangeable aliases.
 *
 * ⚠️ The legacy `risk` field is overloaded — its meaning depends on the
 * container:
 *   - on a CallTree node:    action urgency  (P0..P3)         → v2 .priority
 *   - on a RiskTableEntry:   impact severity (high/medium/...) → v2 .severity
 * v2 split these into two named fields. When migrating data by hand, look at
 * the container, not the field name.
 *
 * On a SymbolImpact / SymbolAnalysis:
 *   new                       legacy             notes
 *   ─────────────────────     ────────────────   ─────────────────────────────
 *   initial_severity          initialRisk        ★ word change: severity (impact
 *                                                magnitude) replaced risk (used
 *                                                ambiguously in v1 for both
 *                                                impact and urgency).
 *
 * On a RiskTableEntry row:
 *   severity                  risk               ★ container-dependent: v1 .risk
 *                                                here meant impact severity (see
 *                                                top-of-section warning).
 *   test_coverage             testCoverage
 *
 * On a CallTree / RiskNode:
 *   call_type                 callType           ★ enum expanded in 2.0
 *                                                (5 values → 16); legacy
 *                                                http_api ⇒ http_call;
 *                                                config_reference / dynamic_dispatch
 *                                                have no v2 equivalent.
 *   priority                  risk               ★ container-dependent: v1 .risk
 *                                                in a node was action urgency
 *                                                (P0..P3); in 2.0 that's
 *                                                .priority (see top warning).
 *                                                Do NOT auto-rename across
 *                                                containers.
 *   test_coverage             testCoverage
 *   domain_context            domainContext
 *
 * On a DownstreamContract entry:
 *   call_kind                 callType           ★ enum is a 7-value subset of
 *                                                CallKind; not the full
 *                                                call_tree call_type vocab.
 *   contract_kind             contractKind
 *   status: "satisfied"       status: "ok"       ★ value rename only; "violated"
 *                                                and "uncertain" unchanged.
 *   sink: { type, repo,       reachesSink +      ★ STRUCTURAL: 3 flat fields
 *           priority?,        sinkRepo +         collapse into one object.
 *           severity? } |     risk               sink: null = legacy
 *           null                                 reachesSink:false. New `type`
 *                                                field adds sink classification
 *                                                (db_write/db_read/
 *                                                http_internal/mq_producer/
 *                                                external_api) — v1 had no
 *                                                equivalent. NO mechanical
 *                                                rename — renderer branches
 *                                                explicitly on which shape it
 *                                                sees.
 *
 * On a TestScenario entry:
 *   risk_change_ids: string[] risk_change_id:    ★ STRUCTURAL: single value →
 *                             string             list. v2 elements MUST be
 *                                                SYM-NNN ids, not function
 *                                                names.
 *   target_api: { name,       affected_api:      ★ STRUCTURAL: free-text route
 *                  namespace, string             string → structured object.
 *                  transport,                    Lossy reverse (legacy text may
 *                  route? }                      not parse cleanly into the new
 *                                                4 fields).
 *   assertions: {kind,        oracle:            ★ STRUCTURAL + ENUM CLOSURE:
 *                channel,     dict<string,       v1 had a free-form dict (33
 *                expression,  string>            ad-hoc keys observed in the
 *                severity,                       wild). v2 closes to 9 kinds
 *                human_                          (api_response / db_check /
 *                description?                    log_check / metric_check /
 *               }[]                              state_check /
 *                                                external_call_check /
 *                                                mock_check /
 *                                                human_observation /
 *                                                code_fix_directive). One
 *                                                assertion per oracle type —
 *                                                never pack multiple checks
 *                                                into one expression.
 *
 * On the artifact root:
 *   unanalyzable[]            untrackable[]      ★ STRUCTURAL: string[] →
 *                                                UnanalyzableItem[] (id /
 *                                                category / subject /
 *                                                implication /
 *                                                suggested_handling). Merger
 *                                                auto-promotes legacy strings
 *                                                to category=schema_unknown
 *                                                / handling=manual, so v1→v2
 *                                                migration is automatic.
 *   global_patterns_matched   globalPatternsMatched
 *
 * Anything not listed here either (a) has the same name in both shapes
 * (e.g. `name`, `location`), or (b) only exists in 2.0 (e.g. `schema_version`,
 * `meta`, `changes[]`, `symbols[].id`, `verification_hints`, `_meta`,
 * `_rawOutput`).
 */

// ─── Call Types (legacy, still accepted by old code paths) ─────────────────────

export type CallType =
  | "direct_call"
  | "http_api"
  | "mq_event"
  | "config_reference"
  | "dynamic_dispatch";

// ─── Risk Levels ───────────────────────────────────────────────────────────────

export type RiskLevel = "P0" | "P1" | "P2" | "P3" | "NEEDS_HUMAN_REVIEW";

/**
 * @deprecated Wider 5-bucket severity used by the legacy AnalysisResult type.
 * cross-repo-impact/2.0 uses InitialSeverity (high/medium/low). Translation:
 * critical→high, high→high, medium→medium, low→low, info→low.
 */
export type RiskSeverity = "critical" | "high" | "medium" | "low" | "info";

// ─── cross-repo-impact/2.0 vocabularies ────────────────────────────────────────

/** schema_version pattern: cross-repo-impact/2.x */
export type CrossRepoImpactSchemaVersion = `cross-repo-impact/2.${number}`;

/** Action urgency. Distinct from severity. */
export type CallPriority = "P0" | "P1" | "P2" | "P3" | "NEEDS_HUMAN_REVIEW";

/** Impact magnitude. Closed to 3 buckets. */
export type InitialSeverity = "high" | "medium" | "low";

export type TestCoverage = "no_test" | "partial" | "has_test";

export type EntryKind =
  | "http_api"
  | "scheduler_job"
  | "mq_consumer"
  | "rpc_method"
  | "internal_only";

/** Closed enum from §canonical_call_kinds. */
export type CallKind =
  | "direct_call"
  | "http_call"
  | "mq_event"
  | "scheduler_trigger"
  | "shared_data_flow"
  | "framework_dispatch"
  | "import_usage"
  | "constant_definition"
  | "field_definition"
  | "parallel_definition"
  | "schema_validation"
  | "dispatch_table"
  | "callback_lookup"
  | "data_transform"
  | "data_read"
  | "indirect_call";

/** Subset of CallKind allowed in downstream_contracts[].call_kind. */
export type DownstreamCallKind =
  | "direct_call"
  | "http_call"
  | "mq_event"
  | "scheduler_trigger"
  | "shared_data_flow"
  | "framework_dispatch"
  | "indirect_call";

export type ContractKind = "param" | "schema" | "transaction" | "other";

export type ContractStatus = "satisfied" | "uncertain" | "violated";

export type SinkType =
  | "db_write"
  | "db_read"
  | "http_internal"
  | "mq_producer"
  | "external_api";

export type ApiNamespace =
  | "cvm"
  | "vstation"
  | "ceres"
  | "ccdb"
  | "billing_internal"
  | "cxm";

export type ApiTransport = "cloud_api" | "vstation" | "internal_rpc" | "scheduler";

export type AssertionKind =
  | "api_response"
  | "db_check"
  | "log_check"
  | "metric_check"
  | "state_check"
  | "external_call_check"
  | "mock_check"
  | "human_observation"
  | "code_fix_directive";

export type AssertionChannel =
  | "cvm_api"
  | "vstation"
  | "mysql"
  | "redis"
  | "cls"
  | "ccdb"
  | "billing_internal"
  | "internal";

export type AssertionSeverity = "must" | "should" | "informational";

export type UnanalyzableCategory =
  | "missing_repo"
  | "runtime_only"
  | "external_service"
  | "duplicated_codebase"
  | "not_imported"
  | "schema_unknown";

export type UnanalyzableHandling = "manual" | "deferred" | "external_team";

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
  /**
   * Stable dedup key computed at submission time from (project, changes, options).
   * Used by the POST /analyze idempotency check to detect duplicate requests.
   * Optional — absent on tasks persisted before this field was introduced.
   */
  dedupKey?: string;
  progress?: TaskProgress;
  /**
   * Output payload. Typed loosely as `unknown` because the runtime can
   * carry either the new CrossRepoImpactArtifact shape OR the legacy
   * AnalysisResult shape during the migration window. Consumers should
   * narrow via `result.schema_version` before reading.
   */
  result?: CrossRepoImpactArtifact | AnalysisResult;
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
  /**
   * Fast-path mode for low-latency analyses (PR previews, CI gating).
   * Trades depth for speed — typically 3-5 minutes vs 9-15 for full mode.
   *
   * What changes when true:
   * - Single pi worker (no symbol-group parallelism)
   * - Skip fine filter (ast-grep) — coarse hits go straight to analysis
   * - Skip entry-point / sink-repo expansion
   * - Skip knowledge-base prefetch
   * - Shorter pi worker timeout (300s vs 900s)
   *
   * Use full mode (this flag false/absent) for release branches, hotfix
   * audits, or any case where missing a P0 risk would be more expensive
   * than the extra wall-clock time.
   */
  quickMode?: boolean;
}

export interface TaskProgress {
  step: number;
  stepName: string;
  reposScanned: number;
  reposTotal: number;
}

// ─── cross-repo-impact/2.0 — primary output schema ─────────────────────────────

/**
 * Top-level output artifact emitted by pi (LLM) and consumed by the renderer.
 * See cross-repo-impact JSON Schema for full field semantics.
 */
export interface CrossRepoImpactArtifact {
  schema_version: CrossRepoImpactSchemaVersion;
  meta: CrossRepoImpactMeta;
  changes: CrossRepoChange[];
  symbols: SymbolImpact[];
  test_scenarios: TestScenario[];
  unanalyzable: UnanalyzableItem[];
  global_patterns_matched?: string[];
  /** Internal pipeline-injected execution metadata; never produced by LLM. */
  _meta?: PipelineExecutionMeta;
  /** Fallback raw text when JSON parse failed; never present on success. */
  _rawOutput?: string;
}

export interface CrossRepoImpactMeta {
  tool_name: string;
  tool_version: string;
  generated_at: string; // ISO-8601 UTC with Z suffix
  dimension_catalog_version: string; // pattern: tapd-requirement-analyzer/4.A-2/v\d+
  knowledge_corpus_versions?: Record<string, string>;
  /** Audit-only flag; consumer always re-sweeps regardless. */
  producer_mask_attempted?: boolean;
}

export interface CrossRepoChange {
  repo: string;
  head_commit: string;
  base_commit?: string;
  branch?: string;
}

export interface SymbolImpact {
  /** Stable id, pattern: SYM-NNN. Used as join key by test_scenarios.risk_change_ids. */
  id: string;
  name: string;
  /** Format: <repo>/<file>:<line>[-<line>]. */
  location: string;
  diff_semantic: string;
  initial_severity: InitialSeverity;
  call_tree: CallTreeNode[];
  risk_table?: RiskTableRow[];
  downstream_contracts?: DownstreamContractRow[];
  verification_hints?: VerificationHint[];
  emit_evidence?: EmitEvidence;
}

export interface CallTreeNode {
  depth: number;
  repo: string;
  file: string;
  line: number;
  function: string;
  /** Structured replacement for legacy "[ENTRY]" string marker. */
  is_entry: boolean;
  /** At most one node per symbol may be true; that node MUST also be is_entry. */
  is_primary_entry?: boolean;
  /** Required when is_entry=true. */
  entry_kind?: EntryKind | null;
  /** Required when entry_kind="http_api". Pattern: ^[A-Z]+ /. */
  entry_route?: string | null;
  call_type: CallKind;
  priority: CallPriority;
  test_coverage: TestCoverage;
  /** Free text. MUST NOT contain "[ENTRY]" markers (use is_entry instead) or emoji. */
  domain_context?: string;
  via?: string;
}

export interface RiskTableRow {
  /** Action urgency. */
  priority: CallPriority;
  /** Impact magnitude. Independent from priority. */
  severity: InitialSeverity;
  function: string;
  location?: string;
  via?: string;
  test_coverage: TestCoverage;
  domain_context?: string;
  remediation: string;
}

export interface DownstreamContractRow {
  callee: string;
  repo?: string;
  file?: string;
  line?: number;
  call_kind: DownstreamCallKind;
  contract_kind: ContractKind;
  status: ContractStatus;
  detail?: string;
  /** null when callee does not reach a sink. */
  sink: SinkDescriptor | null;
}

export interface SinkDescriptor {
  type: SinkType;
  repo: string;
  /** Optional — only present for sinks that actually carry a priority. */
  priority?: CallPriority | null;
  severity?: InitialSeverity | null;
}

export interface VerificationHint {
  /** D1..D11; see §C7 dimension catalog. */
  dim_id: string;
  dim_slug?: string;
  direction: "compatibility-adaptation" | "new-interception" | "query-adaptation";
  rationale?: string;
  expected_acs?: ExpectedAc[];
}

export interface ExpectedAc {
  shape: string;
  /** Required iff parent direction === "new-interception". */
  polarity?: "positive" | "negative";
}

export interface EmitEvidence {
  for_affected_apis?: string[];
  for_risk_areas?: string[];
  for_boundary_conditions?: string[];
}

export interface TestScenario {
  /** Stable id, pattern: RT-NNN. */
  id: string;
  scenario: string;
  /** Foreign keys to symbols[].id. */
  risk_change_ids: string[];
  target_api: TargetApi;
  api_params?: Record<string, unknown>;
  preconditions?: string[];
  steps?: string[];
  assertions: Assertion[];
}

export interface TargetApi {
  /** Bare API identifier; no prefix, no annotation, no Chinese. */
  name: string;
  namespace: ApiNamespace;
  transport: ApiTransport;
  /** Required when transport="cloud_api"; null otherwise. */
  route?: string | null;
  /** Free-text human note. Display-only. */
  annotation?: string;
}

export interface Assertion {
  kind: AssertionKind;
  channel: AssertionChannel;
  /** Format depends on kind; see §C5 expression grammar. */
  expression: string;
  human_description?: string;
  severity: AssertionSeverity;
}

export interface UnanalyzableItem {
  /** Pattern: UA-NNN. */
  id: string;
  category: UnanalyzableCategory;
  subject: string;
  implication: string;
  suggested_handling: UnanalyzableHandling;
}

/** Pipeline-injected execution metadata. Never produced by LLM. */
export interface PipelineExecutionMeta {
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
  timedOut?: boolean;
  degraded?: boolean;
  changeRepo?: string;
  jointMode?: boolean;
  changes?: string[];
}

// ─── Legacy Analysis Result (kept for backward compatibility) ─────────────────
//
// Old call sites still consume the camelCase `AnalysisResult` shape during the
// migration. Renderer reads new snake_case fields when present and falls back
// to these. New code paths should target CrossRepoImpactArtifact instead.

/** @deprecated Use CrossRepoImpactArtifact. */
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

/** @deprecated Use SymbolImpact. */
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

/** @deprecated Use DownstreamContractRow. */
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

/** @deprecated Use RiskTableRow. */
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

/** @deprecated Test plans are now expressed as TestScenario at the artifact root. */
export interface TestPlan {
  target: string;
  scenario: string;
  preconditions: string[];
  testCases: TestCase[];
  observationPoints: string[];
}

/** @deprecated */
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
