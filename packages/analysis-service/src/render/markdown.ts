/**
 * Markdown renderer for AnalysisResult.
 *
 * Pure function — no fs, no fetch, no side effects. Used by:
 *   - GET /api/analyze/:taskId?format=markdown
 *   - scripts/render-report.ts (CLI)
 *
 * Design goals:
 *   1. Make the report consumable by reviewers without `jq` skills.
 *   2. Surface the actionable bits at the top: remediation checklist + test plan.
 *   3. Preserve all fidelity downward — full call tree, downstream contracts,
 *      untrackable items, run metadata. The reader can stop reading at any
 *      depth and still have what they need for that level of decision.
 *   4. Tolerate the LLM's loose JSON shape — fields may be missing, mistyped,
 *      or named in snake_case (test_scenarios) vs camelCase (callTree). We
 *      coerce defensively rather than crash on a malformed entry.
 *
 * Not goals:
 *   - HTML/PDF output. Markdown only — terminals, GitLab/GitHub, Notion all
 *     render it natively.
 *   - Filtering. The renderer shows everything; filtering belongs in the API
 *     query params (future work).
 */

// ─── Inputs (loose by design) ────────────────────────────────────────────────
//
// The renderer accepts `unknown`-ish input rather than the strict
// `AnalysisResult` from @deepinsight/core. Reason: pi/LLM outputs frequently
// drift from the schema (extra fields, missing optional fields, snake_case
// alongside camelCase). Strict typing here would force callers to validate
// upstream, when the renderer can simply degrade gracefully.

type Unknown = Record<string, unknown>;

/**
 * Defensive array coercion. The LLM's output frequently mistypes arrays as
 * objects or strings; without this, a downstream forEach/map would crash the
 * whole render. Returns [] for any non-array input.
 */
function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

interface RenderOptions {
  /** Embed run metadata block (durationMs, turns, etc.). Default true. */
  includeMeta?: boolean;
  /** Maximum depth to expand callTree. Default 6 (LLM rarely goes deeper). */
  maxCallTreeDepth?: number;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function renderMarkdown(
  taskOrResult: Unknown,
  options: RenderOptions = {},
): string {
  // Accept either the full task envelope (with .result, .changes, .createdAt)
  // OR the bare result object. This keeps the CLI flexible — `cat task.json |
  // render` and `cat result.json | render` both work.
  const task = "result" in taskOrResult && taskOrResult.result
    ? taskOrResult
    : { result: taskOrResult };
  const result = (task.result as Unknown) ?? {};

  const opts: Required<RenderOptions> = {
    includeMeta: options.includeMeta ?? true,
    maxCallTreeDepth: options.maxCallTreeDepth ?? 6,
  };

  const sections: string[] = [];
  sections.push(renderHeader(task));
  sections.push(renderSummary(result));

  const checklist = renderActionChecklist(result);
  if (checklist) sections.push(checklist);

  const tests = renderTestPlanChecklist(result);
  if (tests) sections.push(tests);

  sections.push(renderSymbols(result, opts));

  const mermaid = renderCallChainMermaid(result);
  if (mermaid) sections.push(mermaid);

  const untrackable = renderUntrackable(result);
  if (untrackable) sections.push(untrackable);

  const globalPatterns = renderGlobalPatterns(result);
  if (globalPatterns) sections.push(globalPatterns);

  if (opts.includeMeta) {
    const meta = renderMeta(result, task);
    if (meta) sections.push(meta);
  }

  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader(task: Unknown): string {
  const taskId = String(task.taskId ?? task.task_id ?? "(unknown)");
  const project = String(task.project ?? "");
  const status = String(task.status ?? "");

  const lines: string[] = [`# 跨仓影响分析报告`];
  lines.push("");
  if (taskId !== "(unknown)") lines.push(`**Task ID**: \`${taskId}\``);
  if (project) lines.push(`**Project**: ${project}`);
  if (status) lines.push(`**Status**: ${statusEmoji(status)} ${status}`);

  // Changes (repo + branch + commits)
  const changesRaw = task.changes;
  const changes = asArray<Unknown>(changesRaw);
  if (changes.length > 0) {
    lines.push("");
    lines.push("**Changes**:");
    for (const c of changes) {
      const repo = String(c.repo ?? "");
      const branch = c.branch ? ` \`${c.branch}\`` : "";
      const commit = c.commit ? ` @ \`${shortHash(String(c.commit))}\`` : "";
      const base = c.base ? ` (base: \`${shortHash(String(c.base))}\`)` : "";
      lines.push(`- ${repo}${branch}${commit}${base}`);
    }
  }

  // Timing
  const created = task.createdAt;
  const completed = task.completedAt;
  if (created || completed) {
    lines.push("");
    if (created) lines.push(`**Created**: ${created}`);
    if (completed) lines.push(`**Completed**: ${completed}`);
  }

  return lines.join("\n");
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function renderSummary(result: Unknown): string {
  const summary = (result.summary as Unknown) ?? {};
  const rb = (summary.riskBreakdown as Unknown) ?? {};

  const totalSymbols = Number(summary.totalSymbolsChanged ?? 0);
  const affected = Number(summary.affectedRepos ?? 0);
  const unaffected = Number(summary.unaffectedRepos ?? 0);

  const p0 = Number(rb.P0 ?? 0);
  const p1 = Number(rb.P1 ?? 0);
  const p2 = Number(rb.P2 ?? 0);
  const p3 = Number(rb.P3 ?? 0);
  const human = Number(rb.NEEDS_HUMAN_REVIEW ?? 0);

  const lines: string[] = [`## 📊 Summary`];
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 变更符号数 | ${totalSymbols} |`);
  lines.push(`| 受影响仓库 | ${affected} |`);
  lines.push(`| 未受影响仓库 | ${unaffected} |`);
  lines.push("");
  lines.push("### 风险分布");
  lines.push("");
  lines.push("| 优先级 | 数量 | 含义 |");
  lines.push("|---|---|---|");
  lines.push(`| 🔴 **P0** | ${p0} | 阻塞合并 — 高风险且无测试,合并前必须处置 |`);
  lines.push(`| 🟠 **P1** | ${p1} | 必修 — 高风险但测试覆盖不全,需补测试 |`);
  lines.push(`| 🟡 **P2** | ${p2} | 回归 — 中风险或高风险有测试,跑回归 |`);
  lines.push(`| 🟢 **P3** | ${p3} | 观察 — 低风险,无需特殊处置 |`);
  if (human > 0) {
    lines.push(`| ⚠️ **NEEDS_HUMAN_REVIEW** | ${human} | AI 置信度不足,人工确认 |`);
  }

  return lines.join("\n");
}

// ─── Action checklist (P0 + P1 remediation) ──────────────────────────────────

function renderActionChecklist(result: Unknown): string {
  const symbols = asArray<Unknown>(result.symbols);
  const blockers: string[] = []; // P0 + sink-reaching P0 contracts
  const required: string[] = []; // P1
  const sinkOps: string[] = []; // downstreamContracts with reachesSink=true and risk

  for (const sym of symbols) {
    const symName = String(sym.name ?? "");
    const symLoc = String(sym.location ?? "");

    // From riskTable (the reviewer-facing remediation list)
    const riskTable = asArray<Unknown>(sym.riskTable);
    for (const r of riskTable) {
      const priority = String(r.priority ?? "");
      const remediation = String(r.remediation ?? "").trim();
      if (!remediation) continue;
      const loc = String(r.location ?? symLoc);
      const fn = String(r.function ?? symName);
      const item = `**${fn}** \`${loc}\` — ${remediation}`;
      if (priority === "P0") blockers.push(item);
      else if (priority === "P1") required.push(item);
    }

    // Sink-reaching downstream contracts (DB schema, Redis, etc.)
    const dc = asArray<Unknown>(sym.downstreamContracts);
    for (const c of dc) {
      const reachesSink = c.reachesSink === true;
      const risk = String(c.risk ?? "");
      const detail = String(c.detail ?? "").trim();
      if (!reachesSink || !detail) continue;
      // Only surface as action if it carries P0/P1; lower-risk sink contracts
      // are still in the per-symbol detail section below.
      if (risk !== "P0" && risk !== "P1") continue;
      const callee = String(c.callee ?? "");
      const sinkRepo = c.sinkRepo ? ` → \`${c.sinkRepo}\`` : "";
      sinkOps.push(`**Sink**: ${callee}${sinkRepo} — ${detail}`);
    }
  }

  if (blockers.length === 0 && required.length === 0 && sinkOps.length === 0) {
    return "";
  }

  const lines: string[] = [`## ✅ 行动清单`];
  if (blockers.length > 0) {
    lines.push("");
    lines.push(`### 🔴 阻塞合并 (P0) — ${blockers.length} 项`);
    lines.push("");
    for (const b of blockers) lines.push(`- [ ] ${b}`);
  }
  if (sinkOps.length > 0) {
    lines.push("");
    lines.push(`### 🔴 数据/存储层操作 (Sink) — ${sinkOps.length} 项`);
    lines.push("");
    for (const s of sinkOps) lines.push(`- [ ] ${s}`);
  }
  if (required.length > 0) {
    lines.push("");
    lines.push(`### 🟠 必修 (P1) — ${required.length} 项`);
    lines.push("");
    for (const r of required) lines.push(`- [ ] ${r}`);
  }

  return lines.join("\n");
}

// ─── Test plan checklist ─────────────────────────────────────────────────────

function renderTestPlanChecklist(result: Unknown): string {
  // Scenarios live at result.test_scenarios (snake_case from LLM) by convention,
  // but tolerate camelCase too.
  const scenarios = asArray<Unknown>(result.test_scenarios ?? result.testScenarios);
  if (scenarios.length === 0) return "";

  const lines: string[] = [`## 🧪 回归测试场景 (${scenarios.length})`];
  lines.push("");

  scenarios.forEach((s, i) => {
    const name = String(s.scenario ?? `scenario-${i + 1}`);
    const riskId = s.risk_change_id ?? s.riskChangeId;
    const api = s.affected_api ?? s.affectedApi;
    lines.push(`### ${i + 1}. ${name}`);
    lines.push("");
    if (riskId) lines.push(`**关联变更**: \`${riskId}\``);
    if (api) lines.push(`**入口 API**: \`${api}\``);
    lines.push("");

    // Preconditions
    const pre = asArray(s.preconditions);
    if (Array.isArray(pre) && pre.length > 0) {
      lines.push(`**Preconditions**:`);
      for (const p of pre) lines.push(`- ${String(p)}`);
      lines.push("");
    }

    // Steps
    const steps = asArray(s.steps);
    if (Array.isArray(steps) && steps.length > 0) {
      lines.push(`**Steps**:`);
      for (const step of steps) lines.push(`- [ ] ${String(step)}`);
      lines.push("");
    }

    // Oracle
    const oracle = s.oracle;
    if (oracle && typeof oracle === "object" && oracle !== null) {
      lines.push(`**Oracle (验证规则)**:`);
      for (const [k, v] of Object.entries(oracle as Unknown)) {
        lines.push(`- \`${k}\`: ${String(v)}`);
      }
      lines.push("");
    } else if (typeof oracle === "string" && oracle) {
      lines.push(`**Oracle**: ${oracle}`);
      lines.push("");
    }
  });

  return lines.join("\n").trimEnd();
}

// ─── Symbols (full detail) ───────────────────────────────────────────────────

function renderSymbols(result: Unknown, opts: Required<RenderOptions>): string {
  const rawSymbols = result.symbols;
  const symbols: Unknown[] = Array.isArray(rawSymbols) ? (rawSymbols as Unknown[]) : [];
  if (symbols.length === 0) {
    return "## 📍 Symbols\n\n_(no symbols)_";
  }

  const lines: string[] = [`## 📍 Symbols (${symbols.length})`];

  symbols.forEach((sym, i) => {
    const name = String(sym.name ?? `symbol-${i + 1}`);
    const location = String(sym.location ?? "");
    const initialRisk = String(sym.initialRisk ?? "");
    const diffSemantic = String(sym.diffSemantic ?? "").trim();

    lines.push("");
    lines.push(`### ${i + 1}. \`${name}\``);
    lines.push("");
    if (location) lines.push(`**位置**: \`${location}\``);
    if (initialRisk) lines.push(`**初始风险**: ${riskBadge(initialRisk)} ${initialRisk}`);
    if (diffSemantic) {
      lines.push("");
      lines.push(`**Diff 语义**:`);
      lines.push("");
      lines.push(`> ${diffSemantic.replace(/\n/g, "\n> ")}`);
    }

    // Risk table
    const riskTable = asArray<Unknown>(sym.riskTable);
    if (riskTable.length > 0) {
      lines.push("");
      lines.push(`**风险优先级**:`);
      lines.push("");
      lines.push("| 优先级 | 位置 | 函数 | 经由 | 风险 | 测试 | 处置建议 |");
      lines.push("|---|---|---|---|---|---|---|");
      for (const r of riskTable) {
        lines.push(
          `| ${String(r.priority ?? "")} | \`${String(r.location ?? "")}\` | \`${String(r.function ?? "")}\` | ${escapeCell(String(r.via ?? ""))} | ${riskBadge(String(r.risk ?? ""))} ${String(r.risk ?? "")} | ${testCovBadge(String(r.testCoverage ?? ""))} | ${escapeCell(String(r.remediation ?? ""))} |`,
        );
      }
    }

    // Call tree
    const callTree = asArray<Unknown>(sym.callTree);
    if (callTree.length > 0) {
      lines.push("");
      lines.push(`**调用链 (${callTree.length} 节点)**:`);
      lines.push("");
      lines.push("```");
      for (const node of callTree) {
        const depth = Math.min(Number(node.depth ?? 1), opts.maxCallTreeDepth);
        const indent = "  ".repeat(Math.max(0, depth - 1));
        const repo = String(node.repo ?? "");
        const file = String(node.file ?? "");
        const line = node.line ?? "";
        const fn = String(node.function ?? "");
        const callType = String(node.callType ?? "");
        const risk = String(node.risk ?? "");
        const testCov = String(node.testCoverage ?? "");
        const via = node.via ? ` via: ${String(node.via)}` : "";
        const ctx = node.domainContext ? ` [${String(node.domainContext)}]` : "";
        lines.push(
          `${indent}└─ ${repo}/${file}:${line}  ${fn}  (${callType}, ${risk}, ${testCov})${ctx}${via}`,
        );
      }
      lines.push("```");
    }

    // Downstream contracts
    const dc = asArray<Unknown>(sym.downstreamContracts);
    if (dc.length > 0) {
      lines.push("");
      lines.push(`**下行契约 (${dc.length})**:`);
      lines.push("");
      lines.push("| Callee | 类型 | Kind | 状态 | 触达 Sink | 风险 | 详情 |");
      lines.push("|---|---|---|---|---|---|---|");
      for (const c of dc) {
        const callee = String(c.callee ?? "");
        const callType = String(c.callType ?? "");
        const kind = String(c.contractKind ?? "");
        const status = String(c.status ?? "");
        const reaches = c.reachesSink === true ? `✅ ${String(c.sinkRepo ?? "")}` : "—";
        const risk = c.risk ? `${riskBadge(String(c.risk))} ${String(c.risk)}` : "—";
        const detail = String(c.detail ?? "");
        lines.push(
          `| \`${callee}\` | ${callType} | ${kind} | ${statusBadge(status)} ${status} | ${reaches} | ${risk} | ${escapeCell(detail)} |`,
        );
      }
    }
  });

  return lines.join("\n");
}

// ─── Call chain Mermaid diagram ──────────────────────────────────────────────

/**
 * Builds a Mermaid `graph TD` diagram from all symbols' callTree nodes.
 *
 * Each node in the tree carries:
 *   depth    — 1 = direct caller, 2 = indirect caller, …
 *   repo     — repository name
 *   file     — file path (relative to repo root)
 *   line     — line number
 *   function — function / method name
 *   risk     — P0 / P1 / P2 / P3 / high / medium / low / …
 *
 * The changed symbols (depth=0, synthesised from the symbol name itself) are
 * rendered in orange; callers inherit colour by risk level.
 *
 * Layout strategy:
 *   - One root node per changed symbol (:::changed).
 *   - callTree nodes at depth 1 connect directly to the root.
 *   - callTree nodes at depth > 1 connect to the closest ancestor whose
 *     depth is exactly (their depth - 1). We use the insertion-ordered index
 *     within the flattened list as the parent heuristic — this mirrors how
 *     the LLM builds the tree (parent always appears before child).
 *   - If the total node count would exceed MAX_NODES we keep only the
 *     2-hop neighbourhood (depth ≤ 2) and append a truncation notice.
 */
const MAX_NODES = 30;

function renderCallChainMermaid(result: Unknown): string {
  const symbols = asArray<Unknown>(result.symbols);
  if (symbols.length === 0) return "";

  // Collect all callTree nodes across all symbols, tagged with their root symbol.
  interface FlatNode {
    symbolName: string;
    depth: number;
    repo: string;
    file: string;
    line: string | number;
    fn: string;
    risk: string;
    /** Mermaid-safe node id */
    id: string;
    /** id of the parent node in the diagram */
    parentId: string;
  }

  const allNodes: FlatNode[] = [];
  // Map from symbol name → Mermaid root node id
  const rootIds = new Map<string, string>();

  for (const sym of symbols) {
    const symName = String(sym.name ?? "symbol");
    const rootId = safeMermaidId(`root_${symName}`);
    rootIds.set(symName, rootId);

    const callTree = asArray<Unknown>(sym.callTree);

    // Track the last-seen node id at each depth so we can wire up parents.
    const depthStack = new Map<number, string>();
    depthStack.set(0, rootId);

    for (let i = 0; i < callTree.length; i++) {
      const node = callTree[i] as Unknown;
      const depth = Math.max(1, Number(node.depth ?? 1));
      const repo = String(node.repo ?? "");
      const file = String(node.file ?? "");
      const line = node.line ?? "";
      const fn = String(node.function ?? `node_${i}`);
      const risk = String(node.risk ?? "");

      const id = safeMermaidId(`n_${symName}_${i}_${fn}`);
      // Parent = closest ancestor at depth-1; fall back to root if not found.
      const parentId = depthStack.get(depth - 1) ?? rootId;

      allNodes.push({ symbolName: symName, depth, repo, file, line: String(line), fn, risk, id, parentId });
      depthStack.set(depth, id);
    }
  }

  if (allNodes.length === 0) return "";

  // Truncate to 2-hop if too many nodes.
  let truncated = false;
  let nodes = allNodes;
  if (allNodes.length > MAX_NODES) {
    nodes = allNodes.filter((n) => n.depth <= 2);
    truncated = true;
  }

  // Build Mermaid lines.
  const lines: string[] = [];
  lines.push("## 🔗 调用链影响图");
  lines.push("");
  if (truncated) {
    lines.push(`> ⚠️ 节点数超过 ${MAX_NODES}，已截断为 2-hop 邻域。`);
    lines.push("");
  }
  lines.push("```mermaid");
  lines.push("graph TD");

  // Declare root (changed symbol) nodes.
  for (const sym of symbols) {
    const symName = String(sym.name ?? "symbol");
    const rootId = rootIds.get(symName)!;
    const location = String(sym.location ?? "");
    const label = location ? `${symName}<br/><small>${escapeQuote(location)}</small>` : symName;
    lines.push(`  ${rootId}["${label}"]:::changed`);
  }

  // Declare caller nodes and edges.
  const declaredIds = new Set<string>();
  for (const n of nodes) {
    if (!declaredIds.has(n.id)) {
      const loc = n.file ? `${n.repo}/${n.file}:${n.line}` : n.repo;
      const label = `${n.fn}<br/><small>${escapeQuote(loc)}</small>`;
      const cls = riskClass(n.risk);
      lines.push(`  ${n.id}["${label}"]${cls ? `:::${cls}` : ""}`);
      declaredIds.add(n.id);
    }
    lines.push(`  ${n.parentId} --> ${n.id}`);
  }

  // Class definitions.
  lines.push("  classDef changed fill:#f96,stroke:#c33,color:#fff,font-weight:bold");
  lines.push("  classDef riskP0 fill:#fdd,stroke:#c33");
  lines.push("  classDef riskP1 fill:#ffe0cc,stroke:#e07020");
  lines.push("  classDef riskP2 fill:#fffbe6,stroke:#ccaa00");
  lines.push("  classDef riskP3 fill:#e6f4ea,stroke:#2d7a4f");

  lines.push("```");
  lines.push("");
  lines.push("_橙色节点为本次改动的函数；箭头方向为调用方 → 被调用方。_");

  return lines.join("\n");
}

/** Convert a risk string to a Mermaid class name, or empty string if none. */
function riskClass(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "p0" || r === "critical" || r === "high") return "riskP0";
  if (r === "p1") return "riskP1";
  if (r === "p2" || r === "medium") return "riskP2";
  if (r === "p3" || r === "low") return "riskP3";
  return "";
}

/**
 * Sanitise an arbitrary string into a valid Mermaid node id.
 * Mermaid ids must match /[A-Za-z0-9_]+/.
 */
function safeMermaidId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 60) || "node";
}

/** Escape double-quotes inside a Mermaid label string. */
function escapeQuote(s: string): string {
  return s.replace(/"/g, "&quot;");
}

// ─── Untrackable ─────────────────────────────────────────────────────────────
function renderUntrackable(result: Unknown): string {
  const items = asArray(result.untrackable);
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines: string[] = [`## ⚠️ 无法静态追踪 (${items.length})`];
  lines.push("");
  lines.push("> 以下项静态分析无法覆盖,需要人工确认或运行时观察");
  lines.push("");
  for (const item of items) lines.push(`- ${String(item)}`);
  return lines.join("\n");
}

// ─── Global patterns ─────────────────────────────────────────────────────────

function renderGlobalPatterns(result: Unknown): string {
  const items = asArray(result.globalPatternsMatched);
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines: string[] = [`## 🔁 历史风险模式匹配 (${items.length})`];
  lines.push("");
  for (const item of items) lines.push(`- ${String(item)}`);
  return lines.join("\n");
}

// ─── Run metadata ────────────────────────────────────────────────────────────

function renderMeta(result: Unknown, task: Unknown): string {
  const meta = (result._meta as Unknown) ?? {};
  const progress = (task.progress as Unknown) ?? {};

  // Skip section entirely if there's nothing useful
  const hasMeta = Object.keys(meta).length > 0;
  const hasProgress = Object.keys(progress).length > 0;
  if (!hasMeta && !hasProgress) return "";

  const lines: string[] = [`## 📋 执行元信息`];
  lines.push("");
  lines.push("| 字段 | 值 |");
  lines.push("|---|---|");

  if (meta.durationMs !== undefined) {
    const sec = Number(meta.durationMs) / 1000;
    lines.push(`| 总耗时 | ${sec.toFixed(1)}s |`);
  }
  if (meta.turns !== undefined) lines.push(`| LLM turns | ${meta.turns} |`);
  if (meta.toolCalls !== undefined) lines.push(`| 工具调用次数 | ${meta.toolCalls} |`);
  if (meta.timedOut !== undefined) {
    lines.push(`| 超时 | ${meta.timedOut ? "⚠️ 是" : "否"} |`);
  }
  if (meta.degraded !== undefined) {
    lines.push(`| 降级模式 | ${meta.degraded ? "⚠️ 是" : "否"} |`);
  }
  if (meta.changeRepo !== undefined) lines.push(`| 主仓 | \`${meta.changeRepo}\` |`);
  if (meta.jointMode !== undefined) lines.push(`| 联合模式 | ${meta.jointMode ? "是" : "否"} |`);
  if (Array.isArray(meta.changes)) {
    lines.push(`| 涉及仓库 | ${(meta.changes as string[]).join(", ")} |`);
  }
  if (progress.reposScanned !== undefined && progress.reposTotal !== undefined) {
    lines.push(`| 预筛 | ${progress.reposScanned} / ${progress.reposTotal} 仓 |`);
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case "completed": return "✅";
    case "running": return "🔄";
    case "queued": return "⏳";
    case "failed": return "❌";
    default: return "•";
  }
}

function riskBadge(risk: string): string {
  // Accept both severity (high/medium/low) and priority (P0/P1/P2/P3).
  const r = risk.toLowerCase();
  if (r === "p0" || r === "critical" || r === "high") return "🔴";
  if (r === "p1") return "🟠";
  if (r === "p2" || r === "medium") return "🟡";
  if (r === "p3" || r === "low" || r === "info") return "🟢";
  if (r === "needs_human_review") return "⚠️";
  return "•";
}

function testCovBadge(cov: string): string {
  const c = cov.toLowerCase();
  if (c === "full" || c === "has_test") return "✅";
  if (c === "partial") return "⚠️";
  if (c === "none" || c === "no_test") return "❌";
  return cov;
}

function statusBadge(status: string): string {
  const s = status.toLowerCase();
  if (s === "ok" || s === "compatible") return "✅";
  if (s === "violated") return "❌";
  if (s === "uncertain") return "⚠️";
  return "•";
}

/** Escape pipe + newline so a value doesn't break a markdown table row. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function shortHash(hash: string): string {
  return hash.length > 10 ? hash.slice(0, 10) : hash;
}
