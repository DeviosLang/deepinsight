/**
 * kbPrefetch.ts — Phase 1.5: T0 Pre-flight knowledge base lookup.
 *
 * Before spawning pi, the service layer proactively queries knowledge bases
 * whose keywords match the diff content. Results are injected as a "background
 * summary" section at the top of the prompt, so pi has context from the very
 * first reasoning turn rather than needing to discover and query mid-flight.
 *
 * Design constraints:
 *   - Each query uses --budget 500 (lightweight, ~500 tokens output)
 *   - All matched KBs are queried in parallel (Promise.allSettled)
 *   - Hard timeout: 30s per query; total cap: 60s (never blocks pi spawn)
 *   - At most MAX_PREFETCH_KBS knowledge bases per task (cost guard)
 *   - A KB is only queried if ≥1 of its keywords appears in the diff
 */

import { spawnSync } from "node:child_process";

export interface KnowledgeBase {
  name: string;
  description: string;
  keywords: string[];
  graphPath: string;
}

export interface KbPrefetchResult {
  name: string;
  description: string;
  query: string;
  answer: string;
}

const MAX_PREFETCH_KBS = 3;          // 最多并发查 3 个库（成本控制）
const QUERY_BUDGET_TOKENS = 500;     // 每次查询输出上限（轻量摘要）
const QUERY_TIMEOUT_MS = 30_000;     // 单次查询超时 30s
const TOTAL_TIMEOUT_MS = 60_000;     // 整体超时 60s（绝不阻塞 pi spawn）

/**
 * Match knowledge bases to the diff based on keyword overlap.
 * Returns KBs sorted by match score (descending), capped at MAX_PREFETCH_KBS.
 */
function matchKbsToDiff(
  diff: string,
  kbs: KnowledgeBase[],
): Array<{ kb: KnowledgeBase; query: string; score: number }> {
  const diffLower = diff.toLowerCase();
  const scored: Array<{ kb: KnowledgeBase; query: string; score: number }> = [];

  for (const kb of kbs) {
    const hits = kb.keywords.filter((kw) => diffLower.includes(kw.toLowerCase()));
    if (hits.length === 0) continue;

    // Build a focused query from matched keywords + kb description
    const query = buildQuery(kb, hits, diff);
    scored.push({ kb, query, score: hits.length });
  }

  // Sort by score desc, take top N
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PREFETCH_KBS);
}

/**
 * Build a natural-language query for graphify based on matched keywords and diff context.
 * Extracts up to 3 changed symbol names to make the query more targeted.
 */
function buildQuery(kb: KnowledgeBase, hits: string[], diff: string): string {
  // Extract changed function/class names from diff (lines starting with +/-)
  const symbolPattern = /^[+-]\s*(?:def |class |async def )(\w+)/gm;
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = symbolPattern.exec(diff)) !== null && symbols.length < 3) {
    if (!symbols.includes(m[1])) symbols.push(m[1]);
  }

  const symbolHint = symbols.length > 0 ? `（涉及符号：${symbols.join("、")}）` : "";
  const kwHint = hits.slice(0, 3).join("、");

  // Each KB gets a query tailored to its domain
  switch (kb.name) {
    case "cvm_design_docs":
      return `diff 修改了涉及 ${kwHint} 的代码${symbolHint}，请说明相关模块的架构设计、模块边界和关键约束`;
    case "cvm_domain":
      return `diff 涉及 ${kwHint}${symbolHint}，请解释相关业务概念的定义和业务规则`;
    case "cvm_apidocs":
      return `diff 修改了 ${kwHint} 相关逻辑${symbolHint}，请说明对应的对外 API 接口签名、入参约束和错误码`;
    case "cvm_released_bugs":
      return `diff 修改了 ${kwHint}${symbolHint}，历史上是否有相似改动导致过发布故障？`;
    case "cvm_tapd_bugs":
      return `diff 涉及 ${kwHint}${symbolHint}，是否有相关的历史 bug 或迭代需求记录？`;
    default:
      return `diff 涉及 ${kwHint}${symbolHint}，请提供相关背景知识`;
  }
}

/**
 * Run a single graphify query synchronously with timeout.
 * Returns the stdout text, or null on failure/timeout.
 */
function runGraphifyQuery(query: string, graphPath: string): string | null {
  const result = spawnSync(
    "graphify",
    ["query", query, "--graph", graphPath, "--budget", String(QUERY_BUDGET_TOKENS)],
    {
      timeout: QUERY_TIMEOUT_MS,
      encoding: "utf-8",
      maxBuffer: 512 * 1024,
    },
  );

  if (result.error || result.status !== 0) {
    return null;
  }

  const output = result.stdout?.trim();
  return output && output.length > 20 ? output : null;
}

/**
 * Main entry point: pre-fetch relevant knowledge bases for a given diff.
 *
 * Called in pipeline.ts between Step 3 (pre-filter) and Step 4 (spawn pi).
 * Returns an array of prefetch results to be injected into the prompt.
 * Always resolves within TOTAL_TIMEOUT_MS — never throws.
 */
export async function prefetchKnowledgeBases(
  diff: string,
  kbs: KnowledgeBase[] | undefined,
  taskId: string,
): Promise<KbPrefetchResult[]> {
  if (!kbs || kbs.length === 0) return [];
  if (!diff || diff.length < 50) return [];

  const matched = matchKbsToDiff(diff, kbs);
  if (matched.length === 0) {
    console.log(`[kb-prefetch:${taskId}] No KB keywords matched diff, skipping`);
    return [];
  }

  console.log(
    `[kb-prefetch:${taskId}] Matched ${matched.length} KB(s): ${matched.map((m) => `${m.kb.name}(score=${m.score})`).join(", ")}`,
  );

  // Race all queries against a global timeout
  const totalTimeout = new Promise<KbPrefetchResult[]>((resolve) =>
    setTimeout(() => {
      console.warn(`[kb-prefetch:${taskId}] Global timeout (${TOTAL_TIMEOUT_MS}ms), returning partial results`);
      resolve([]);
    }, TOTAL_TIMEOUT_MS),
  );

  const queries = Promise.allSettled(
    matched.map(async ({ kb, query }) => {
      const start = Date.now();
      const answer = runGraphifyQuery(query, kb.graphPath);
      const elapsed = Date.now() - start;

      if (!answer) {
        console.log(`[kb-prefetch:${taskId}]   ${kb.name}: no result (${elapsed}ms)`);
        return null;
      }

      console.log(`[kb-prefetch:${taskId}]   ${kb.name}: ${answer.length} chars (${elapsed}ms)`);
      return {
        name: kb.name,
        description: kb.description,
        query,
        answer,
      } satisfies KbPrefetchResult;
    }),
  ).then((results) =>
    results
      .filter((r): r is PromiseFulfilledResult<KbPrefetchResult | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is KbPrefetchResult => v !== null),
  );

  return Promise.race([queries, totalTimeout]);
}
