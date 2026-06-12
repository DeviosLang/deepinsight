/**
 * Tests for schemaLint — covers the 9 categories of drift observed in
 * production task analysis-1781248014591-wd1yna (2026-06-12).
 *
 * Each test mirrors one specific drift seen in that task's output, plus
 * a few synthetic edge cases for robustness.
 */

import { describe, it, expect } from "vitest";
import { lintCrossRepoImpact, isLintEnabled, DRIFT_HEAVY_THRESHOLD } from "../orchestrator/schemaLint.js";

describe("schemaLint - downstream_contracts field name normalization", () => {
  it("renames kind → call_kind with method_call → direct_call mapping", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo._bar",
          downstream_contracts: [{ callee: "Vm.x", kind: "method_call", status: "satisfied" }],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const dc = (normalized.symbols as Record<string, unknown>[])[0].downstream_contracts as Record<string, unknown>[];
    expect(dc[0].call_kind).toBe("direct_call");
    expect(dc[0].kind).toBeUndefined();
    expect(warnings.find((w) => w.category === "downstream_contracts.kind_to_call_kind")).toBeDefined();
  });

  it("renames contract_type → contract_kind preserving legal values", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          downstream_contracts: [{ callee: "X", contract_type: "param", status: "satisfied" }],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const dc = (normalized.symbols as Record<string, unknown>[])[0].downstream_contracts as Record<string, unknown>[];
    expect(dc[0].contract_kind).toBe("param");
    expect(dc[0].contract_type).toBeUndefined();
    expect(warnings.find((w) => w.category === "downstream_contracts.contract_type_to_contract_kind")).toBeDefined();
  });

  it("collapses illegal contract_type values to 'other'", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          downstream_contracts: [{ callee: "X", contract_type: "magical", status: "satisfied" }],
        },
      ],
    };
    const { normalized } = lintCrossRepoImpact(obj);
    const dc = (normalized.symbols as Record<string, unknown>[])[0].downstream_contracts as Record<string, unknown>[];
    expect(dc[0].contract_kind).toBe("other");
  });

  it("explodes nested {param:{}, schema:{}, transaction:{}} into multiple flat entries", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          downstream_contracts: [
            {
              callee: "DeviceStub::RenewCvmDevice",
              callee_repo: "cvm_ccdb",
              param: { status: "uncertain", detail: "p-detail" },
              schema: { status: "satisfied", detail: "s-detail" },
              transaction: { status: "satisfied", detail: "t-detail" },
            },
          ],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const dc = (normalized.symbols as Record<string, unknown>[])[0].downstream_contracts as Record<string, unknown>[];
    expect(dc).toHaveLength(3);
    expect(dc.map((r) => r.contract_kind).sort()).toEqual(["param", "schema", "transaction"]);
    expect(dc[0].callee).toBe("DeviceStub::RenewCvmDevice");
    expect(dc[0].callee_repo).toBe("cvm_ccdb");
    expect(warnings.find((w) => w.category === "downstream_contracts.nested_facets")).toBeDefined();
  });

  it("renames status:'ok' → 'satisfied'", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          downstream_contracts: [{ callee: "X", call_kind: "direct_call", contract_kind: "param", status: "ok" }],
        },
      ],
    };
    const { normalized } = lintCrossRepoImpact(obj);
    const dc = (normalized.symbols as Record<string, unknown>[])[0].downstream_contracts as Record<string, unknown>[];
    expect(dc[0].status).toBe("satisfied");
  });
});

describe("schemaLint - test_scenarios drift", () => {
  it("injects empty api_params when missing", () => {
    const obj = {
      test_scenarios: [
        {
          id: "RT-001",
          target_api: { name: "X", namespace: "cvm", transport: "cloud_api" },
          assertions: [],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const ts = (normalized.test_scenarios as Record<string, unknown>[])[0];
    expect(ts.api_params).toEqual({});
    expect(warnings.find((w) => w.category === "test_scenarios.api_params_missing")).toBeDefined();
  });

  it("maps transport: HTTP/http_api → cloud_api", () => {
    const obj = {
      test_scenarios: [
        {
          id: "RT-001",
          target_api: { name: "X", namespace: "cvm", transport: "HTTP" },
          api_params: {},
          assertions: [],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const ts = (normalized.test_scenarios as Record<string, unknown>[])[0];
    const ta = ts.target_api as Record<string, unknown>;
    expect(ta.transport).toBe("cloud_api");
    expect(warnings.find((w) => w.category === "target_api.transport_invalid")).toBeDefined();
  });

  it("maps transport: des_pipeline → internal_rpc", () => {
    const obj = {
      test_scenarios: [
        {
          id: "RT-009",
          target_api: { name: "X", namespace: "cvm", transport: "des_pipeline" },
          api_params: {},
          assertions: [],
        },
      ],
    };
    const { normalized } = lintCrossRepoImpact(obj);
    const ts = (normalized.test_scenarios as Record<string, unknown>[])[0];
    const ta = ts.target_api as Record<string, unknown>;
    expect(ta.transport).toBe("internal_rpc");
  });

  it("maps illegal assertions[].kind values to closest legal enum", () => {
    const obj = {
      test_scenarios: [
        {
          id: "RT-001",
          target_api: { name: "X", namespace: "cvm", transport: "cloud_api" },
          api_params: {},
          assertions: [
            { kind: "http_status", expected: 200 },
            { kind: "context_value", expected: "ctx.foo = 3" },
            { kind: "des_task", expected: "x" },
            { kind: "external_call", expected: "y" },
            { kind: "log_contains", expected: "z" },
          ],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const ts = (normalized.test_scenarios as Record<string, unknown>[])[0];
    const a = ts.assertions as Record<string, unknown>[];
    expect(a[0].kind).toBe("api_response");
    expect(a[1].kind).toBe("state_check");
    expect(a[2].kind).toBe("state_check");
    expect(a[3].kind).toBe("external_call_check");
    expect(a[4].kind).toBe("log_check");
    // Original kept for debugging
    expect(a[0]._original_kind).toBe("http_status");
    // 5 mapping warnings
    expect(warnings.filter((w) => w.category === "assertions.kind_invalid_mapped")).toHaveLength(5);
  });

  it("warns (not maps) on unknown assertion.kind values", () => {
    const obj = {
      test_scenarios: [
        {
          id: "RT-001",
          target_api: { name: "X", namespace: "cvm", transport: "cloud_api" },
          api_params: {},
          assertions: [{ kind: "totally_made_up", expected: "?" }],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const ts = (normalized.test_scenarios as Record<string, unknown>[])[0];
    const a = ts.assertions as Record<string, unknown>[];
    expect(a[0].kind).toBe("totally_made_up"); // left alone
    expect(warnings.find((w) => w.category === "assertions.kind_invalid_unmapped")).toBeDefined();
  });
});

describe("schemaLint - symbols drift", () => {
  it("flattens diff_semantic from object to string + lifts change_type/initial_severity", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo._bar",
          diff_semantic: {
            change_type: "additive_conditional",
            initial_severity: "medium",
            description: "新增分支",
          },
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const sym = (normalized.symbols as Record<string, unknown>[])[0];
    expect(sym.diff_semantic).toBe("新增分支");
    expect(sym.change_type).toBe("additive_conditional");
    expect(sym.initial_severity).toBe("medium");
    expect(warnings.find((w) => w.category === "symbols.diff_semantic_type")).toBeDefined();
  });

  it("synthesizes location='file:line' from split file+line fields", () => {
    const obj = {
      symbols: [{ id: "SYM-001", symbol: "Foo", file: "ccdb/api/query_vm.py", line: 40 }],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const sym = (normalized.symbols as Record<string, unknown>[])[0];
    expect(sym.location).toBe("ccdb/api/query_vm.py:40");
    expect(warnings.find((w) => w.category === "symbols.location_split")).toBeDefined();
  });

  it("warns when name is unrelated to symbol", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "QueryVmTempDevice._process",
          name: "PRIVILEGE_TYPE_IGNORE_PREPAID_PERIODIC_CONTRACT_FORCE_SOLD_OUT",
        },
      ],
    };
    const { warnings } = lintCrossRepoImpact(obj);
    expect(warnings.find((w) => w.category === "symbols.name_symbol_mismatch")).toBeDefined();
  });

  it("does NOT warn when name shares an identifier with symbol", () => {
    const obj = {
      symbols: [
        { id: "SYM-001", symbol: "QueryVmTempDevice._process", name: "QueryVmTempDevice (handler)" },
      ],
    };
    const { warnings } = lintCrossRepoImpact(obj);
    expect(warnings.find((w) => w.category === "symbols.name_symbol_mismatch")).toBeUndefined();
  });
});

describe("schemaLint - call_tree drift", () => {
  it("renames caller → function and transport → call_type", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          call_tree: [{ caller: "x.y.z", depth: 1, transport: "http", is_entry: false }],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const node = ((normalized.symbols as Record<string, unknown>[])[0].call_tree as Record<string, unknown>[])[0];
    expect(node.function).toBe("x.y.z");
    expect(node.call_type).toBe("http_call");
    expect(node.caller).toBeUndefined();
    expect(node.transport).toBeUndefined();
    expect(warnings.find((w) => w.category === "call_tree.function_field_name")).toBeDefined();
    expect(warnings.find((w) => w.category === "call_tree.transport_to_call_type")).toBeDefined();
  });
});

describe("schemaLint - risk_table drift", () => {
  it("splits caller_path into function + location", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          risk_table: [
            { caller_path: "cvm_api::DES::cvm_ccdb.update_periodic_contract_recycle_status", priority: "P1", severity: "medium", remediation: "x" },
          ],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const row = ((normalized.symbols as Record<string, unknown>[])[0].risk_table as Record<string, unknown>[])[0];
    expect(row.function).toBe("cvm_ccdb.update_periodic_contract_recycle_status");
    expect(row.location).toBe("cvm_api::DES");
    expect(row.caller_path).toBeUndefined();
    expect(warnings.find((w) => w.category === "risk_table.caller_path_split")).toBeDefined();
  });

  it("synthesizes [FALLBACK] remediation for P1 row missing it", () => {
    const obj = {
      symbols: [
        {
          id: "SYM-008",
          symbol: "Foo",
          risk_table: [
            {
              priority: "P1",
              severity: "high",
              domain_context: "计费逻辑伪装为 PREPAY",
            },
          ],
        },
      ],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const row = ((normalized.symbols as Record<string, unknown>[])[0].risk_table as Record<string, unknown>[])[0];
    expect(typeof row.remediation).toBe("string");
    expect(row.remediation).toMatch(/\[FALLBACK/);
    expect(warnings.find((w) => w.category === "risk_table.p0p1_missing_remediation")).toBeDefined();
  });
});

describe("schemaLint - meta whitelist", () => {
  it("moves non-whitelisted meta keys to meta._extra", () => {
    const obj = {
      meta: {
        tool_name: "deepinsight-pi",
        tool_version: "2.0",
        generated_at: "2026-06-12T00:00:00Z",
        analysis_id: "ANL-X",
        total_symbols: 18,
        summary: "...",
      },
      test_scenarios: [],
    };
    const { warnings, normalized } = lintCrossRepoImpact(obj);
    const meta = normalized.meta as Record<string, unknown>;
    expect(meta.analysis_id).toBeUndefined();
    expect(meta.total_symbols).toBeUndefined();
    expect(meta.tool_name).toBe("deepinsight-pi"); // whitelisted, kept
    const extra = meta._extra as Record<string, unknown>;
    expect(extra.analysis_id).toBe("ANL-X");
    expect(extra.total_symbols).toBe(18);
    expect(warnings.find((w) => w.category === "meta.unknown_keys")).toBeDefined();
  });

  it("flags meta.total_test_scenarios mismatched with array length", () => {
    const obj = {
      meta: { total_test_scenarios: 8, tool_name: "x", tool_version: "2.0", generated_at: "2026-06-12" },
      test_scenarios: [
        { id: "RT-001" },
        { id: "RT-002" },
        { id: "RT-003" },
      ],
    };
    const { warnings } = lintCrossRepoImpact(obj);
    expect(warnings.find((w) => w.category === "meta.counter_mismatch")).toBeDefined();
  });
});

describe("schemaLint - aggregate behavior", () => {
  it("returns categories map and counts", () => {
    const obj = {
      meta: { tool_name: "x", tool_version: "2.0", generated_at: "t", extra1: 1, extra2: 2 },
      symbols: [
        {
          id: "SYM-001",
          symbol: "Foo",
          downstream_contracts: [
            { callee: "X", kind: "method_call" },
            { callee: "Y", kind: "data_flow" },
          ],
        },
      ],
    };
    const { warnings, categories } = lintCrossRepoImpact(obj);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(categories["downstream_contracts.kind_to_call_kind"]).toBe(2);
  });

  it("DRIFT_HEAVY_THRESHOLD is 70", () => {
    expect(DRIFT_HEAVY_THRESHOLD).toBe(70);
  });

  it("isLintEnabled defaults to true (env unset)", () => {
    const original = process.env.DEEPINSIGHT_SCHEMA_LINT;
    delete process.env.DEEPINSIGHT_SCHEMA_LINT;
    expect(isLintEnabled()).toBe(true);
    if (original !== undefined) process.env.DEEPINSIGHT_SCHEMA_LINT = original;
  });

  it("isLintEnabled respects DEEPINSIGHT_SCHEMA_LINT=off", () => {
    const original = process.env.DEEPINSIGHT_SCHEMA_LINT;
    process.env.DEEPINSIGHT_SCHEMA_LINT = "off";
    expect(isLintEnabled()).toBe(false);
    process.env.DEEPINSIGHT_SCHEMA_LINT = "OFF";
    expect(isLintEnabled()).toBe(false);
    process.env.DEEPINSIGHT_SCHEMA_LINT = "false";
    expect(isLintEnabled()).toBe(false);
    if (original !== undefined) process.env.DEEPINSIGHT_SCHEMA_LINT = original;
    else delete process.env.DEEPINSIGHT_SCHEMA_LINT;
  });

  it("does not throw on null/undefined input", () => {
    expect(() => lintCrossRepoImpact(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => lintCrossRepoImpact(undefined as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => lintCrossRepoImpact({})).not.toThrow();
  });

  it("clean cross-repo-impact/2.0 input produces zero warnings", () => {
    const clean = {
      schema_version: "cross-repo-impact/2.0",
      meta: {
        tool_name: "deepinsight-pi",
        tool_version: "2.0",
        generated_at: "2026-06-12T00:00:00Z",
      },
      symbols: [
        {
          id: "SYM-001",
          symbol: "push_db",
          location: "aurora/db/tasks/db_period_task.py:1421",
          diff_semantic: "添加 hasattr 守卫",
          initial_severity: "medium",
          call_tree: [
            { depth: 1, repo: "aurora", file: "x.py", function: "push_db", is_entry: false, call_type: "direct_call", priority: "P2", test_coverage: "has_test" },
          ],
          risk_table: [{ priority: "P2", severity: "medium", function: "push_db", location: "aurora/db.py:1", test_coverage: "has_test", remediation: "ok" }],
          downstream_contracts: [
            { callee: "X", call_kind: "direct_call", contract_kind: "schema", status: "satisfied", detail: "ok", sink: null },
          ],
        },
      ],
      test_scenarios: [
        {
          id: "RT-001",
          scenario: "x",
          risk_change_ids: ["SYM-001"],
          target_api: { name: "Foo", namespace: "cvm", transport: "cloud_api", route: "POST /?Action=Foo" },
          api_params: {},
          preconditions: [],
          steps: [],
          assertions: [{ kind: "api_response", channel: "cvm_api", expression: "x", severity: "must" }],
        },
      ],
    };
    const { warnings } = lintCrossRepoImpact(clean);
    expect(warnings).toHaveLength(0);
  });
});
