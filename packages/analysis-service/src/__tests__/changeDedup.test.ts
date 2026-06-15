/**
 * Unit tests for change deduplication key helpers in pipeline.ts.
 *
 * These functions determine whether a ChangeSpec is a duplicate:
 *   - changeBranchKey: Layer 1, before git fetch — same (repo, branch) pair
 *   - changeRangeKey:  Layer 2, after resolution — same (repo, base, commit)
 *
 * Test data mirrors the actual incident task analysis-1781529438103-4eq7kl
 * where cvm_api/feature/monthly_contract_billing_mode was submitted twice,
 * causing a full duplicate pi worker run.
 */
import { describe, test, expect } from "vitest";
import {
  __changeBranchKeyForTest as changeBranchKey,
  __changeRangeKeyForTest as changeRangeKey,
} from "../orchestrator/pipeline.js";

describe("changeBranchKey (Layer 1 dedup)", () => {
  test("same repo + same branch → same key (incident replay)", () => {
    const a = { repo: "cvm_api", branch: "feature/monthly_contract_billing_mode" };
    const b = { repo: "cvm_api", branch: "feature/monthly_contract_billing_mode" };
    expect(changeBranchKey(a)).toBe(changeBranchKey(b));
  });

  test("same repo + different branch → different key", () => {
    const a = { repo: "cvm_api", branch: "feature/monthly_contract_billing_mode" };
    const b = { repo: "cvm_api", branch: "feature/fix_bill_contract_mode" };
    expect(changeBranchKey(a)).not.toBe(changeBranchKey(b));
  });

  test("different repo + same branch name → different key", () => {
    const a = { repo: "cvm_api",   branch: "feature/monthly_contract_billing_mode" };
    const b = { repo: "cvm_ccdb",  branch: "feature/monthly_contract_billing_mode" };
    expect(changeBranchKey(a)).not.toBe(changeBranchKey(b));
  });

  test("uses commit as fallback when branch is absent", () => {
    const a = { repo: "cvm_api", commit: "abc123" };
    const b = { repo: "cvm_api", commit: "abc123" };
    expect(changeBranchKey(a)).toBe(changeBranchKey(b));
  });

  test("commit-only and branch-only with same value → same key (edge case)", () => {
    // Both stringify to "cvm_api::abc123"
    const a = { repo: "cvm_api", branch: "abc123" };
    const b = { repo: "cvm_api", commit: "abc123" };
    expect(changeBranchKey(a)).toBe(changeBranchKey(b));
  });

  test("empty branch/commit → key is still repo-scoped", () => {
    const a = { repo: "cvm_api" };
    const b = { repo: "cvm_ccdb" };
    expect(changeBranchKey(a)).not.toBe(changeBranchKey(b));
  });

  // Incident replay: all 8 changes from analysis-1781529438103-4eq7kl
  test("incident replay: dedup set reduces 8 entries to 7 unique branch keys", () => {
    const changes = [
      { repo: "cvm_api",           branch: "feature/monthly_contract_billing_mode" },
      { repo: "cvm_api",           branch: "feature/fix_bill_contract_mode" },
      { repo: "cvm_api",           branch: "feature/monthly_contract_billing_mode" }, // dup of [0]
      { repo: "cvm_ccdb",          branch: "feature/monthly_contract_billing_mode" },
      { repo: "vstation_ccdb",     branch: "feature/monthly_contract_billing_mode" },
      { repo: "vstation_ceres",    branch: "feature/monthly-contract-mode" },
      { repo: "vstation_ceres",    branch: "feature/monthly_contract_billing_mode" },
      { repo: "vstation_allinone", branch: "feature/monthly_contract_billing_mode" },
    ];

    const seen = new Set<string>();
    for (const c of changes) seen.add(changeBranchKey(c));

    // 8 entries - 1 duplicate (cvm_api/monthly_contract_billing_mode) = 7 unique keys
    expect(seen.size).toBe(7);
  });
});

describe("changeRangeKey (Layer 2 dedup)", () => {
  test("same repo + same base + same commit → same key", () => {
    const base = "aabbccdd" + "0".repeat(32);
    const commit = "eeff0011" + "0".repeat(32);
    const a = { repo: "cvm_api", base, commit };
    const b = { repo: "cvm_api", base, commit };
    expect(changeRangeKey(a)).toBe(changeRangeKey(b));
  });

  test("different commit → different key", () => {
    const base = "base0000" + "0".repeat(32);
    const a = { repo: "cvm_api", base, commit: "aaaa1111" + "0".repeat(32) };
    const b = { repo: "cvm_api", base, commit: "bbbb2222" + "0".repeat(32) };
    expect(changeRangeKey(a)).not.toBe(changeRangeKey(b));
  });

  test("different base → different key", () => {
    const commit = "commit00" + "0".repeat(32);
    const a = { repo: "cvm_api", base: "base0001" + "0".repeat(32), commit };
    const b = { repo: "cvm_api", base: "base0002" + "0".repeat(32), commit };
    expect(changeRangeKey(a)).not.toBe(changeRangeKey(b));
  });

  test("different repo → different key even with same commits", () => {
    const base   = "base0000" + "0".repeat(32);
    const commit = "commit00" + "0".repeat(32);
    const a = { repo: "cvm_api",  base, commit };
    const b = { repo: "cvm_ccdb", base, commit };
    expect(changeRangeKey(a)).not.toBe(changeRangeKey(b));
  });

  test("layer 2 catches same-content branches with different names", () => {
    // Two branches that were fast-forwarded to same tip and share same merge-base
    const base   = "mergebase" + "0".repeat(31);
    const commit = "tiphash00" + "0".repeat(31);
    const branchA = { repo: "cvm_api", branch: "feature/branch-a", base, commit };
    const branchB = { repo: "cvm_api", branch: "feature/branch-b", base, commit };

    // Layer 1 would NOT catch this (different branch names)
    expect(changeBranchKey(branchA)).not.toBe(changeBranchKey(branchB));

    // Layer 2 DOES catch this (same resolved commit range)
    expect(changeRangeKey(branchA)).toBe(changeRangeKey(branchB));
  });

  test("missing base/commit → does not collide with populated entries", () => {
    const a = { repo: "cvm_api" };                                   // no base, no commit
    const b = { repo: "cvm_api", base: "", commit: "" };             // explicit empty strings
    const c = { repo: "cvm_api", base: "abc", commit: "def" };      // populated

    expect(changeRangeKey(a)).toBe(changeRangeKey(b));   // both empty → same key (will be skipped gracefully)
    expect(changeRangeKey(a)).not.toBe(changeRangeKey(c));
  });
});
