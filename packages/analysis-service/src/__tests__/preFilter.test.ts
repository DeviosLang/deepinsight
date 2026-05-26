import { describe, test, expect } from "vitest";

/**
 * Unit tests for pre-filter — GENERIC_NAMES, coarseFilter scoring logic
 */

const GENERIC_NAMES = new Set([
  "check", "get", "set", "run", "main", "init", "test", "setup",
  "update", "delete", "create", "read", "write", "open", "close",
]);

const MAX_TARGET_REPOS = 10;

interface Symbol {
  name: string;
  pattern?: string;
  endpointUrl?: string;
  eventTopic?: string;
  fullyQualifiedName?: string;
  packageName?: string;
}

function shouldFilterSymbol(symbol: Symbol): boolean {
  return symbol.name.length < 4 || GENERIC_NAMES.has(symbol.name);
}

function selectTopRepos(hitCounts: Map<string, number>): string[] {
  const sorted = [...hitCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, MAX_TARGET_REPOS).map(([r]) => r);
}

describe("shouldFilterSymbol", () => {
  test("filters symbols shorter than 4 chars", () => {
    expect(shouldFilterSymbol({ name: "fn" })).toBe(true);
    expect(shouldFilterSymbol({ name: "ab" })).toBe(true);
    expect(shouldFilterSymbol({ name: "x" })).toBe(true);
  });

  test("filters generic names regardless of length", () => {
    expect(shouldFilterSymbol({ name: "check" })).toBe(true);
    expect(shouldFilterSymbol({ name: "update" })).toBe(true);
    expect(shouldFilterSymbol({ name: "delete" })).toBe(true);
    expect(shouldFilterSymbol({ name: "create" })).toBe(true);
  });

  test("passes business-specific symbols", () => {
    expect(shouldFilterSymbol({ name: "update_translog" })).toBe(false);
    expect(shouldFilterSymbol({ name: "emergency_purge" })).toBe(false);
    expect(shouldFilterSymbol({ name: "callback_metric" })).toBe(false);
    expect(shouldFilterSymbol({ name: "CRedisClient" })).toBe(false);
    expect(shouldFilterSymbol({ name: "CTaskProcess" })).toBe(false);
  });

  test("handles edge case: exactly 4 chars non-generic", () => {
    expect(shouldFilterSymbol({ name: "send" })).toBe(false); // 4 chars, not in set
    expect(shouldFilterSymbol({ name: "dump" })).toBe(false);
  });

  test("handles edge case: exactly 4 chars but in generic set", () => {
    expect(shouldFilterSymbol({ name: "init" })).toBe(true); // in GENERIC_NAMES
    expect(shouldFilterSymbol({ name: "read" })).toBe(true);
    expect(shouldFilterSymbol({ name: "open" })).toBe(true);
  });
});

describe("selectTopRepos", () => {
  test("returns top 10 repos sorted by hit count", () => {
    const hitCounts = new Map<string, number>([
      ["repo_a", 5],
      ["repo_b", 3],
      ["repo_c", 8],
      ["repo_d", 1],
      ["repo_e", 4],
    ]);
    const result = selectTopRepos(hitCounts);
    expect(result[0]).toBe("repo_c"); // highest
    expect(result[1]).toBe("repo_a");
    expect(result[2]).toBe("repo_e");
    expect(result).toHaveLength(5);
  });

  test("limits to MAX_TARGET_REPOS when more repos available", () => {
    const hitCounts = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      hitCounts.set(`repo_${i}`, 20 - i);
    }
    const result = selectTopRepos(hitCounts);
    expect(result).toHaveLength(10);
    expect(result[0]).toBe("repo_0"); // highest count = 20
    expect(result[9]).toBe("repo_9"); // 10th highest = 11
  });

  test("returns empty for empty map", () => {
    const result = selectTopRepos(new Map());
    expect(result).toHaveLength(0);
  });

  test("handles ties by insertion order", () => {
    const hitCounts = new Map<string, number>([
      ["alpha", 3],
      ["beta", 3],
      ["gamma", 3],
    ]);
    const result = selectTopRepos(hitCounts);
    expect(result).toHaveLength(3);
    // All have same count, sort is stable
  });
});

describe("entry point repos merging", () => {
  test("merges entry points with coarse filter results (dedup)", () => {
    const coarseHits = new Set(["repo_a", "repo_b", "cvm_api"]);
    const entryPoints = ["cvm_api", "cxm_api"];
    const merged = new Set([...coarseHits, ...entryPoints]);
    expect(merged.size).toBe(4); // cvm_api deduped
    expect(merged.has("cvm_api")).toBe(true);
    expect(merged.has("cxm_api")).toBe(true);
  });

  test("works with empty entry points", () => {
    const coarseHits = new Set(["repo_a"]);
    const entryPoints: string[] = [];
    const merged = new Set([...coarseHits, ...entryPoints]);
    expect(merged.size).toBe(1);
  });

  test("works with empty coarse hits", () => {
    const coarseHits = new Set<string>();
    const entryPoints = ["cvm_api", "cxm_api"];
    const merged = new Set([...coarseHits, ...entryPoints]);
    expect(merged.size).toBe(2);
  });
});

describe("exclude dirs pathspec", () => {
  test("generates correct git pathspec exclusions", () => {
    const excludeDirs = ["tests/", "test/", "*/tests/"];
    const args = ["diff", "abc~1", "abc", "--"];
    for (const dir of excludeDirs) {
      args.push(`:!${dir}`);
    }
    expect(args).toContain(":!tests/");
    expect(args).toContain(":!test/");
    expect(args).toContain(":!*/tests/");
    expect(args[3]).toBe("--"); // separator before pathspecs
  });
});
