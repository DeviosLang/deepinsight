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
 * Covers 5 layers: direct symbol + HTTP endpoint + MQ topic + config ref + reverse dep.
 */
export function coarseFilter(
  symbols: Symbol[],
  allRepos: string[],
  repoManager: RepoManager,
): Set<string> {
  const hits = new Set<string>();

  for (const repo of allRepos) {
    if (!repoManager.repoExists(repo)) continue;

    for (const symbol of symbols) {
      // Layer 1: Direct symbol name
      const symHits = repoManager.gitGrep(repo, symbol.name);
      if (symHits.length > 0) {
        hits.add(repo);
        break;
      }

      // Layer 2: HTTP endpoint URL
      if (symbol.endpointUrl) {
        const httpHits = repoManager.gitGrep(repo, symbol.endpointUrl);
        if (httpHits.length > 0) {
          hits.add(repo);
          break;
        }
      }

      // Layer 3: MQ topic
      if (symbol.eventTopic) {
        const mqHits = repoManager.gitGrep(repo, symbol.eventTopic);
        if (mqHits.length > 0) {
          hits.add(repo);
          break;
        }
      }

      // Layer 4: Config reference (YAML/JSON)
      if (symbol.fullyQualifiedName) {
        const cfgHits = repoManager.gitGrep(repo, symbol.fullyQualifiedName, [
          "*.yaml",
          "*.yml",
          "*.json",
          "*.toml",
        ]);
        if (cfgHits.length > 0) {
          hits.add(repo);
          break;
        }
      }

      // Layer 5: Reverse dependency (who imports the package)
      if (symbol.packageName) {
        const importHits = repoManager.gitGrep(repo, symbol.packageName);
        if (importHits.length > 0) {
          hits.add(repo);
          break;
        }
      }
    }
  }

  return hits;
}

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
  const coarseHits = coarseFilter(symbols, allRepos, repoManager);
  const fineHits = await fineFilter(symbols, coarseHits, taskId, repoManager);

  return { symbols, coarseHits, fineHits };
}
