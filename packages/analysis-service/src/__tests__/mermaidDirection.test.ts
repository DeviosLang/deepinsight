import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../render/markdown.js";

describe("renderCallChainMermaid", () => {
  it("arrows go caller -> callee (top-down) and changed nodes are marked", () => {
    const result = {
      symbols: [
        {
          name: "_get_cmdb_info (inner: local disk target sequential assignment)",
          location: "business/common/des_v2.py:944",
          call_tree: [
            {
              depth: 1,
              repo: "cvm_api",
              file: "business/cvm/RunInstances.py",
              line: 100,
              function: "RunInstances",
              priority: "P2",
            },
            {
              depth: 2,
              repo: "cloud_api",
              file: "api/cloud.py",
              line: 50,
              function: "cloud_entry",
              priority: "P2",
            },
          ],
        },
      ],
    } as unknown as Record<string, unknown>;

    const md = renderMarkdown(
      result as unknown as never,
      { progress: {} } as never,
    );
    const mm = md.split("```mermaid")[1]?.split("```")[0] ?? "";

    // Changed root node is declared with :::changed and ✏️ prefix
    expect(mm).toMatch(/✏️ _get_cmdb_info/);
    expect(mm).toMatch(/:::changed/);

    // The RunInstances entry node should point TO the changed root (caller -> callee)
    // i.e. an edge of form "  <runinstancesId> --> <rootId>"
    const rootId = "root__get_cmdb_info__inner__local_disk_target_sequential_ass";
    const runInstancesEdges = mm
      .split("\n")
      .filter((l) => l.includes("-->") && l.trimEnd().endsWith(rootId));
    expect(runInstancesEdges.length).toBeGreaterThan(0);

    // No edge should point FROM root TO the entry (old wrong direction)
    const wrongDir = mm
      .split("\n")
      .filter((l) => l.trimStart().startsWith(rootId + " -->"));
    expect(wrongDir.length).toBe(0);

    // No duplicate edges (node id collision regression guard)
    const edges = mm.split("\n").filter((l) => l.includes("-->"));
    const uniq = new Set(edges.map((e) => e.trim()));
    expect(uniq.size).toBe(edges.length);
  });
});
