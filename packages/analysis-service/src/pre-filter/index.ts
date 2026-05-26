/**
 * Pre-filter — Two-phase filtering to narrow 56 repos down to 5-10.
 *
 * Phase 1 (coarseFilter): git grep on NFS repos (fast enough for sequential reads)
 * Phase 2 (fineFilter): ast-grep on local worktrees (needs fast I/O)
 */

import { spawnSync } from "node:child_process";
import type { RepoManager } from "../repo/repoManager.js";

export interface Symbol {
  name: string;
  pattern?: string;
  isApiHandler?: boolean;
  endpointUrl?: string;
  eventTopic?: string;
  fullyQualifiedName?: string;
  packageName?: string;
}

export interface PreFilterResult {
  symbols: Symbol[];
  coarseHits: Set<string>;
  fineHits: Set<string>;
}

/**
 * Phase 1: Coarse filter using git grep on NFS (no worktree needed).
 * Runs all repos IN PARALLEL for speed. Each repo's symbols are checked sequentially.
 * Returns top MAX_TARGET_REPOS repos sorted by hit count.
 */
export async function coarseFilter(
  symbols: Symbol[],
  allRepos: string[],
  repoManager: RepoManager,
): Promise<Set<string>> {
  // Filter symbols first — skip generic names
  const filteredSymbols = symbols.filter(
    (s) => s.name.length >= 4 && !GENERIC_NAMES.has(s.name),
  );

  // Run all repos in parallel (limited concurrency to avoid NFS overload)
  const CONCURRENCY = 10;
  const hitCounts = new Map<string, number>();

  for (let i = 0; i < allRepos.length; i += CONCURRENCY) {
    const batch = allRepos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (repo) => {
        if (!repoManager.repoExists(repo)) return { repo, count: 0 };

        let count = 0;
        for (const symbol of filteredSymbols) {
          // Layer 1: Direct symbol name
          const symHits = await repoManager.gitGrepAsync(repo, symbol.name);
          if (symHits.length > 0) {
            count++;
            continue;
          }

          // Layer 2: HTTP endpoint URL
          if (symbol.endpointUrl) {
            const httpHits = await repoManager.gitGrepAsync(repo, symbol.endpointUrl);
            if (httpHits.length > 0) {
              count++;
              continue;
            }
          }

          // Layer 3: MQ topic
          if (symbol.eventTopic) {
            const mqHits = await repoManager.gitGrepAsync(repo, symbol.eventTopic);
            if (mqHits.length > 0) {
              count++;
              continue;
            }
          }

          // Layer 4: Config reference (YAML/JSON)
          if (symbol.fullyQualifiedName) {
            const cfgHits = await repoManager.gitGrepAsync(repo, symbol.fullyQualifiedName);
            if (cfgHits.length > 0) {
              count++;
              continue;
            }
          }

          // Layer 5: Reverse dependency (who imports the package)
          if (symbol.packageName) {
            const importHits = await repoManager.gitGrepAsync(repo, symbol.packageName);
            if (importHits.length > 0) {
              count++;
              continue;
            }
          }
        }

        return { repo, count };
      }),
    );

    for (const { repo, count } of results) {
      if (count > 0) hitCounts.set(repo, count);
    }
  }

  // Sort by hit count descending, take top MAX_TARGET_REPOS
  const sorted = [...hitCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topRepos = sorted.slice(0, MAX_TARGET_REPOS);

  console.log(`[pre-filter] ${hitCounts.size} repos hit, top ${topRepos.length}: ${topRepos.map(([r, c]) => `${r}(${c})`).join(', ')}`);

  return new Set(topRepos.map(([r]) => r));
}

/** Max repos to pass to pi for detailed analysis */
const MAX_TARGET_REPOS = 10;

/** Symbol names too generic for grep (would match everything) */
const GENERIC_NAMES = new Set([
  "check", "get", "set", "run", "main", "init", "test", "setup",
  "update", "delete", "create", "read", "write", "open", "close",
]);

/**
 * Phase 2: Fine filter using ast-grep on local worktrees.
 * Only runs on repos that passed coarse filter.
 */
export async function fineFilter(
  symbols: Symbol[],
  coarseHits: Set<string>,
  taskId: string,
  repoManager: RepoManager,
): Promise<Set<string>> {
  const fineHits = new Set<string>();

  for (const repo of coarseHits) {
    const confirmed = await repoManager.withWorktree(taskId, repo, "HEAD", async (wtPath) => {
      for (const symbol of symbols) {
        const pattern = symbol.pattern ?? `${symbol.name}($$$)`;
        const result = spawnSync(
          "sg",
          ["--pattern", pattern, "--lang", "python", "--json", wtPath],
          { timeout: 30_000, encoding: "utf-8" },
        );

        if (result.status === 0) {
          try {
            const matches = JSON.parse(result.stdout);
            if (Array.isArray(matches) && matches.length > 0) {
              return true;
            }
          } catch {
            // Parse error, skip
          }
        }
      }
      return false;
    });

    if (confirmed) {
      fineHits.add(repo);
    }
  }

  return fineHits;
}

/**
 * Full pre-filter pipeline: coarse (NFS) → fine (local SSD).
 */
export async function preFilter(
  symbols: Symbol[],
  allRepos: string[],
  taskId: string,
  repoManager: RepoManager,
): Promise<PreFilterResult> {
  const coarseHits = await coarseFilter(symbols, allRepos, repoManager);
  const fineHits = await fineFilter(symbols, coarseHits, taskId, repoManager);

  return { symbols, coarseHits, fineHits };
}
