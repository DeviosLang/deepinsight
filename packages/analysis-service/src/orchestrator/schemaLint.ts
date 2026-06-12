/**
 * Strict content-level lint for cross-repo-impact/2.0 outputs.
 *
 * `validateAnalysisResult()` (pipeline.ts) only checks shape: schema_version
 * matches, top-level arrays exist. It does NOT validate field names, enum
 * values, or required-field presence.
 *
 * In production we observed pi LLM outputs that pass shape validation but
 * are actually 60+ field-name / enum-value drifts away from the schema:
 *
 *   - downstream_contracts[].kind / contract_type   (should be call_kind / contract_kind)
 *   - target_api.transport: "HTTP" / "des_pipeline"  (should be cloud_api / internal_rpc)
 *   - assertions[].kind: "http_status" / "des_task"  (should be one of 9 closed enums)
 *   - test_scenarios[] missing api_params            (downstream agents need it)
 *   - diff_semantic: object instead of string        (early-output drift mode)
 *
 * Downstream agents silently mis-handle these and produce empty DAGs, FAIL_ENV
 * test cases, or lost P1 risks.
 *
 * This module performs:
 *
 *   1. Detection — flag every field-name / enum / required-field drift as a
 *      structured warning (category + path + before/after).
 *   2. Normalization — apply known equivalence mappings so downstream
 *      consumers receive a schema-compliant JSON regardless of pi drift.
 *   3. Telemetry — surface aggregate counts via Opik trace metadata so we
 *      can watch drift rate over time as the prompt is refined.
 *
 * Per design (Q1/Q2/Q3 in chat, 2026-06-12):
 *   - Warn-only, NO automatic retry — even at high warning counts.
 *   - Categories tracked but no `error` severity gates retry.
 *   - Disable via env: DEEPINSIGHT_SCHEMA_LINT=off  (default: on).
 */

const NINE_ASSERTION_KINDS = new Set([
  "api_response",
  "db_check",
  "log_check",
  "metric_check",
  "state_check",
  "external_call_check",
  "mock_check",
  "human_observation",
  "code_fix_directive",
]);

const FOUR_TRANSPORTS = new Set(["cloud_api", "vstation", "internal_rpc", "scheduler"]);

const SEVEN_CALL_KINDS = new Set([
  "direct_call",
  "http_call",
  "mq_event",
  "scheduler_trigger",
  "shared_data_flow",
  "framework_dispatch",
  "indirect_call",
]);

const FOUR_CONTRACT_KINDS = new Set(["param", "schema", "transaction", "other"]);

const META_WHITELIST = new Set([
  "tool_name",
  "tool_version",
  "generated_at",
  "dimension_catalog_version",
]);

// Maps pi-generated illegal assertion.kind → closest legal one.
// See output-schema.md §4.6 for rationale of each mapping.
const ASSERTION_KIND_MAP: Record<string, string> = {
  http_status: "api_response",
  http_response: "api_response",
  response_field: "api_response",
  error_code: "api_response",
  error_message: "api_response",
  log_contains: "log_check",
  context_value: "state_check",
  des_task: "state_check",
  external_call: "external_call_check",
  trade_goods: "human_observation", // not API-observable, needs human verification
};

const TRANSPORT_MAP: Record<string, string> = {
  HTTP: "cloud_api",
  http: "cloud_api",
  http_api: "cloud_api",
  des_pipeline: "internal_rpc",
};

// pi sometimes uses these as call_type substitutes; map to closest legal value.
const CALL_TYPE_FROM_TRANSPORT: Record<string, string> = {
  http: "http_call",
  https: "http_call",
  direct_call: "direct_call",
  mq: "mq_event",
};

export type LintSeverity = "warn"; // (Q1: no error level — warn-only)

export interface LintWarning {
  category: string; // e.g. "downstream_contracts.call_kind"
  path: string; // e.g. "symbols[3].downstream_contracts[1]"
  message: string; // human-readable
  before?: unknown; // the offending value, if applicable
  after?: unknown; // the normalized value, if applicable
}

export interface LintResult {
  warnings: LintWarning[];
  /** Original was mutated in place; this is the same reference. */
  normalized: Record<string, unknown>;
  /** Per-category count, useful for trace metadata. */
  categories: Record<string, number>;
}

/**
 * Walk the pi-generated cross-repo-impact/2.0 artifact, normalize known
 * field-name / enum-value drifts, and collect warnings. Mutates `obj`.
 *
 * Caller decides what to do with warnings (log, attach to trace metadata,
 * surface in API response). This function never throws on drift — even
 * grossly malformed input produces a bag of warnings, not an exception.
 */
export function lintCrossRepoImpact(obj: Record<string, unknown>): LintResult {
  const warnings: LintWarning[] = [];

  if (!obj || typeof obj !== "object") {
    return { warnings, normalized: obj, categories: {} };
  }

  // ─── meta ────────────────────────────────────────────────────────────────
  if (obj.meta && typeof obj.meta === "object") {
    const meta = obj.meta as Record<string, unknown>;
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(meta)) {
      if (!META_WHITELIST.has(key)) {
        extras[key] = meta[key];
        delete meta[key];
      }
    }
    if (Object.keys(extras).length > 0) {
      // Preserve under _extra so info isn't lost (e.g. analysis_id, summary).
      meta._extra = extras;
      warnings.push({
        category: "meta.unknown_keys",
        path: "meta",
        message: `meta contained ${Object.keys(extras).length} non-whitelisted keys (moved to meta._extra)`,
        before: Object.keys(extras),
      });
    }

    // Counter sanity: total_test_scenarios mismatched with array length is
    // a recurring producer bug — strip it (already moved to _extra above).
    const tsLen = Array.isArray(obj.test_scenarios) ? obj.test_scenarios.length : 0;
    const claimed = (extras.total_test_scenarios as number | undefined) ?? null;
    if (claimed !== null && claimed !== tsLen) {
      warnings.push({
        category: "meta.counter_mismatch",
        path: "meta.total_test_scenarios",
        message: `claimed ${claimed} but actual test_scenarios.length = ${tsLen}`,
        before: claimed,
        after: tsLen,
      });
    }
  }

  // ─── symbols[] ───────────────────────────────────────────────────────────
  const symbols = obj.symbols;
  if (Array.isArray(symbols)) {
    symbols.forEach((sym, sIdx) => {
      if (!sym || typeof sym !== "object") return;
      lintSymbol(sym as Record<string, unknown>, `symbols[${sIdx}]`, warnings);
    });
  }

  // ─── test_scenarios[] ────────────────────────────────────────────────────
  const scenarios = obj.test_scenarios;
  if (Array.isArray(scenarios)) {
    scenarios.forEach((ts, tIdx) => {
      if (!ts || typeof ts !== "object") return;
      lintTestScenario(ts as Record<string, unknown>, `test_scenarios[${tIdx}]`, warnings);
    });
  }

  // ─── Aggregate categories ────────────────────────────────────────────────
  const categories: Record<string, number> = {};
  for (const w of warnings) {
    categories[w.category] = (categories[w.category] ?? 0) + 1;
  }

  return { warnings, normalized: obj, categories };
}

// ─── symbol-level checks ──────────────────────────────────────────────────────

function lintSymbol(
  sym: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): void {
  // diff_semantic: object → string (proper) + lift change_type / initial_severity
  if (sym.diff_semantic && typeof sym.diff_semantic === "object") {
    const ds = sym.diff_semantic as Record<string, unknown>;
    const desc = typeof ds.description === "string" ? ds.description : JSON.stringify(ds);
    if (ds.change_type !== undefined && sym.change_type === undefined) {
      sym.change_type = ds.change_type;
    }
    if (ds.initial_severity !== undefined && sym.initial_severity === undefined) {
      sym.initial_severity = ds.initial_severity;
    }
    sym.diff_semantic = desc;
    warnings.push({
      category: "symbols.diff_semantic_type",
      path: `${path}.diff_semantic`,
      message: "diff_semantic was an object; flattened to string + lifted change_type/initial_severity to top-level",
    });
  }

  // location: prefer single "file:line" string. If only file+line present, synthesize.
  if (typeof sym.location !== "string") {
    const file = typeof sym.file === "string" ? sym.file : null;
    const line = typeof sym.line === "number" ? sym.line : null;
    if (file && line !== null) {
      sym.location = `${file}:${line}`;
      warnings.push({
        category: "symbols.location_split",
        path: `${path}.location`,
        message: "location was split into file+line; synthesized single 'file:line' string",
        after: sym.location,
      });
    } else if (file) {
      sym.location = file;
      warnings.push({
        category: "symbols.location_missing_line",
        path: `${path}.location`,
        message: "location had file but no line",
        after: sym.location,
      });
    }
  }

  // call_tree[]
  if (Array.isArray(sym.call_tree)) {
    sym.call_tree.forEach((node, i) => {
      if (!node || typeof node !== "object") return;
      lintCallTreeNode(node as Record<string, unknown>, `${path}.call_tree[${i}]`, warnings);
    });
  }

  // risk_table[]
  if (Array.isArray(sym.risk_table)) {
    sym.risk_table.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      lintRiskTableRow(row as Record<string, unknown>, `${path}.risk_table[${i}]`, warnings);
    });
  }

  // downstream_contracts[]
  if (Array.isArray(sym.downstream_contracts)) {
    const original = sym.downstream_contracts;
    // First pass: explode nested {param:{...}, schema:{...}, transaction:{...}}
    // into multiple flat entries (each with its own contract_kind).
    const exploded: Record<string, unknown>[] = [];
    for (let i = 0; i < original.length; i++) {
      const dc = original[i];
      if (!dc || typeof dc !== "object") {
        exploded.push(dc as Record<string, unknown>);
        continue;
      }
      const expanded = explodeNestedContractKinds(
        dc as Record<string, unknown>,
        `${path}.downstream_contracts[${i}]`,
        warnings,
      );
      exploded.push(...expanded);
    }
    sym.downstream_contracts = exploded;

    // Second pass: per-element field-name / enum normalization.
    exploded.forEach((dc, i) => {
      if (!dc || typeof dc !== "object") return;
      lintDownstreamContract(dc, `${path}.downstream_contracts[${i}]`, warnings);
    });
  }

  // name vs symbol divergence — informational warn only (unfixable from data).
  if (typeof sym.name === "string" && typeof sym.symbol === "string") {
    if (!stringsLikelyShareSymbol(sym.name, sym.symbol)) {
      warnings.push({
        category: "symbols.name_symbol_mismatch",
        path: `${path}.name`,
        message: `name "${truncate(sym.name, 60)}" appears unrelated to symbol "${truncate(sym.symbol, 60)}" — possible field misalignment`,
      });
    }
  }
}

function lintCallTreeNode(
  node: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): void {
  // caller → function rename (SYM-004 et al)
  if (typeof node.caller === "string" && typeof node.function !== "string") {
    node.function = node.caller;
    delete node.caller;
    warnings.push({
      category: "call_tree.function_field_name",
      path: `${path}.function`,
      message: "field 'caller' renamed to 'function'",
    });
  }

  // transport → call_type field-name + value mapping
  if (typeof node.transport === "string" && typeof node.call_type !== "string") {
    const before = node.transport;
    const mapped = CALL_TYPE_FROM_TRANSPORT[before] ?? before;
    if (!isLegalCallType(mapped)) {
      warnings.push({
        category: "call_tree.transport_unmapped",
        path: `${path}.call_type`,
        message: `transport='${before}' has no clean call_type mapping; left as-is for human review`,
      });
      node.call_type = mapped;
    } else {
      node.call_type = mapped;
      warnings.push({
        category: "call_tree.transport_to_call_type",
        path: `${path}.call_type`,
        message: `field 'transport' renamed to 'call_type'`,
        before,
        after: mapped,
      });
    }
    delete node.transport;
  }

  // node-level kind (collides with symbol.kind): if it's a call_type-ish value,
  // promote to call_type. Otherwise leave alone.
  if (typeof node.kind === "string" && typeof node.call_type !== "string") {
    const v = node.kind;
    if (CALL_TYPE_FROM_TRANSPORT[v] || isLegalCallType(v)) {
      node.call_type = CALL_TYPE_FROM_TRANSPORT[v] ?? v;
      delete node.kind;
      warnings.push({
        category: "call_tree.kind_to_call_type",
        path: `${path}.call_type`,
        message: "field 'kind' renamed to 'call_type'",
        before: v,
        after: node.call_type,
      });
    }
  }
}

function lintRiskTableRow(
  row: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): void {
  // caller_path → split into function + location heuristically.
  // Format observed: "cvm_api::DES::cvm_ccdb.update_periodic_contract_recycle_status"
  if (typeof row.caller_path === "string" && (typeof row.function !== "string" || typeof row.location !== "string")) {
    const cp = row.caller_path;
    const lastDoubleColon = cp.lastIndexOf("::");
    if (lastDoubleColon >= 0) {
      const fnPart = cp.slice(lastDoubleColon + 2);
      if (typeof row.function !== "string") row.function = fnPart;
      if (typeof row.location !== "string") row.location = cp.slice(0, lastDoubleColon);
    } else {
      if (typeof row.function !== "string") row.function = cp;
    }
    delete row.caller_path;
    warnings.push({
      category: "risk_table.caller_path_split",
      path: `${path}.function`,
      message: "field 'caller_path' split into function + location",
    });
  }

  // change_impact → description (rename only when description is missing)
  if (typeof row.change_impact === "string" && typeof row.description !== "string") {
    row.description = row.change_impact;
    delete row.change_impact;
    warnings.push({
      category: "risk_table.change_impact_to_description",
      path: `${path}.description`,
      message: "field 'change_impact' renamed to 'description'",
    });
  }

  // P0/P1 missing remediation → fallback to domain_context / description, prefix [FALLBACK]
  const priority = row.priority;
  if ((priority === "P0" || priority === "P1") && typeof row.remediation !== "string") {
    const fallback =
      (typeof row.domain_context === "string" ? row.domain_context : null) ??
      (typeof row.description === "string" ? row.description : null);
    if (fallback) {
      row.remediation = `[FALLBACK from domain_context/description] ${fallback}`;
      warnings.push({
        category: "risk_table.p0p1_missing_remediation",
        path: `${path}.remediation`,
        message: `${priority} row missing required 'remediation' field; synthesized from domain_context/description`,
      });
    } else {
      warnings.push({
        category: "risk_table.p0p1_missing_remediation",
        path: `${path}.remediation`,
        message: `${priority} row missing 'remediation' AND no fallback source available — high-risk item may disappear from downstream risk_areas`,
      });
    }
  }
}

/**
 * Some pi outputs nest contract_kind facets inside the same array element:
 *
 *   { callee: "X", param: {status, detail}, schema: {status, detail} }
 *
 * The schema requires one row per contract_kind. Explode such an entry into
 * multiple flat entries.
 */
function explodeNestedContractKinds(
  dc: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): Record<string, unknown>[] {
  const facets = ["param", "schema", "transaction"] as const;
  const nestedFacets = facets.filter(
    (k) => dc[k] && typeof dc[k] === "object" && !Array.isArray(dc[k]) &&
      // detect facet-shape: has at least one of {status, detail}
      ("status" in (dc[k] as Record<string, unknown>) || "detail" in (dc[k] as Record<string, unknown>)),
  );

  if (nestedFacets.length === 0) return [dc];

  warnings.push({
    category: "downstream_contracts.nested_facets",
    path,
    message: `entry contained nested facets ${JSON.stringify(nestedFacets)}; exploded into ${nestedFacets.length} flat row(s)`,
  });

  const base: Record<string, unknown> = { ...dc };
  for (const f of facets) delete base[f];

  return nestedFacets.map((f) => {
    const facet = dc[f] as Record<string, unknown>;
    return {
      ...base,
      contract_kind: f,
      status: facet.status ?? "uncertain",
      detail: facet.detail ?? "",
    };
  });
}

function lintDownstreamContract(
  dc: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): void {
  // kind → call_kind (with value mapping for "method_call" / "data_flow" etc.)
  if (typeof dc.kind === "string" && typeof dc.call_kind !== "string") {
    const before = dc.kind;
    const mapped = mapToCallKind(before);
    dc.call_kind = mapped;
    delete dc.kind;
    warnings.push({
      category: "downstream_contracts.kind_to_call_kind",
      path: `${path}.call_kind`,
      message: "field 'kind' renamed to 'call_kind'",
      before,
      after: mapped,
    });
  }

  // contract_type → contract_kind (value preserved if legal; else "other")
  if (typeof dc.contract_type === "string" && typeof dc.contract_kind !== "string") {
    const before = dc.contract_type;
    const after = FOUR_CONTRACT_KINDS.has(before) ? before : "other";
    dc.contract_kind = after;
    delete dc.contract_type;
    warnings.push({
      category: "downstream_contracts.contract_type_to_contract_kind",
      path: `${path}.contract_kind`,
      message: "field 'contract_type' renamed to 'contract_kind'",
      before,
      after,
    });
  }

  // status: "ok" → "satisfied"
  if (dc.status === "ok") {
    dc.status = "satisfied";
    warnings.push({
      category: "downstream_contracts.status_ok_to_satisfied",
      path: `${path}.status`,
      message: "status 'ok' renamed to 'satisfied'",
    });
  }

  // call_kind value validation
  if (typeof dc.call_kind === "string" && !SEVEN_CALL_KINDS.has(dc.call_kind)) {
    const before = dc.call_kind;
    const after = mapToCallKind(before);
    dc.call_kind = after;
    if (after !== before) {
      warnings.push({
        category: "downstream_contracts.call_kind_invalid",
        path: `${path}.call_kind`,
        message: `call_kind='${before}' not in closed enum; mapped to '${after}'`,
        before,
        after,
      });
    }
  }
}

// ─── test_scenarios[] checks ──────────────────────────────────────────────────

function lintTestScenario(
  ts: Record<string, unknown>,
  path: string,
  warnings: LintWarning[],
): void {
  // api_params required
  if (ts.api_params === undefined) {
    ts.api_params = {};
    warnings.push({
      category: "test_scenarios.api_params_missing",
      path: `${path}.api_params`,
      message: "api_params field missing; injected empty {}",
    });
  }

  // target_api.transport
  if (ts.target_api && typeof ts.target_api === "object") {
    const ta = ts.target_api as Record<string, unknown>;
    if (typeof ta.transport === "string" && !FOUR_TRANSPORTS.has(ta.transport)) {
      const before = ta.transport;
      const after = TRANSPORT_MAP[before] ?? "internal_rpc";
      ta.transport = after;
      warnings.push({
        category: "target_api.transport_invalid",
        path: `${path}.target_api.transport`,
        message: `transport='${before}' not in 4-enum; mapped to '${after}'`,
        before,
        after,
      });
    }
  }

  // assertions[].kind
  if (Array.isArray(ts.assertions)) {
    ts.assertions.forEach((a, i) => {
      if (!a || typeof a !== "object") return;
      const assertion = a as Record<string, unknown>;
      if (typeof assertion.kind === "string" && !NINE_ASSERTION_KINDS.has(assertion.kind)) {
        const before = assertion.kind;
        const after = ASSERTION_KIND_MAP[before];
        if (after) {
          assertion.kind = after;
          assertion._original_kind = before; // preserve for debugging
          warnings.push({
            category: "assertions.kind_invalid_mapped",
            path: `${path}.assertions[${i}].kind`,
            message: `kind='${before}' not in 9-enum; mapped to '${after}'`,
            before,
            after,
          });
        } else {
          warnings.push({
            category: "assertions.kind_invalid_unmapped",
            path: `${path}.assertions[${i}].kind`,
            message: `kind='${before}' not in 9-enum and no mapping available; left as-is for human review`,
            before,
          });
        }
      }
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isLegalCallType(v: string): boolean {
  return [
    "direct_call",
    "http_call",
    "mq_event",
    "scheduler_trigger",
    "shared_data_flow",
    "framework_dispatch",
    "import_usage",
    "constant_definition",
    "field_definition",
    "parallel_definition",
    "schema_validation",
    "dispatch_table",
    "callback_lookup",
    "data_transform",
    "data_read",
    "indirect_call",
  ].includes(v);
}

function mapToCallKind(v: string): string {
  // Direct hits first
  if (SEVEN_CALL_KINDS.has(v)) return v;
  // Known aliases
  const aliases: Record<string, string> = {
    method_call: "direct_call",
    function_call: "direct_call",
    rpc_call: "direct_call",
    rpc_caller: "direct_call",
    data_flow: "shared_data_flow",
    workflow_context: "shared_data_flow",
    mq_producer: "mq_event",
    mq_consumer: "mq_event",
    http_api: "http_call",
    framework: "framework_dispatch",
  };
  return aliases[v] ?? "indirect_call";
}

function stringsLikelyShareSymbol(a: string, b: string): boolean {
  // Heuristic: do they share at least one identifier-ish substring of length ≥ 4?
  // Avoids false positives on totally-unrelated strings while tolerating
  // "ClassName.method" vs "ClassName" etc.
  const norm = (s: string) => s.replace(/[^A-Za-z0-9_]/g, " ").split(/\s+/).filter((w) => w.length >= 4);
  const wordsA = new Set(norm(a));
  for (const w of norm(b)) if (wordsA.has(w)) return true;
  return false;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─── feature flag ─────────────────────────────────────────────────────────────

/**
 * Returns false when DEEPINSIGHT_SCHEMA_LINT=off (string compare, case-insensitive).
 * Anything else (unset, "on", "true", "yes", "") enables lint. This is the
 * fail-safe-on default — if the env var is fat-fingered, lint still runs.
 */
export function isLintEnabled(): boolean {
  const raw = (process.env.DEEPINSIGHT_SCHEMA_LINT ?? "").trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0" && raw !== "no";
}

/**
 * Threshold above which we log an aggregated "drift heavy" line. Q2 in chat:
 * 70+. This is a logging signal only — does NOT trigger retry.
 */
export const DRIFT_HEAVY_THRESHOLD = 70;
