/**
 * Repository Manager — manages access to git repos on NFS + temp worktrees on local storage.
 *
 * NFS layout (shirakami-workspace):
 *   /data/workspace/{repoName}/          ← full clone with .git
 *   /data/workspace/{repoName}/.git/
 *
 * Local scratch (emptyDir SSD):
 *   /data/scratch/{taskId}/{repoName}/   ← temporary worktree for ast-grep
 */

import { execFileSync, spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoConfig } from "@deepinsight/core";

export interface RepoManagerConfig {
  /** Base directory for repo data (NFS mount with full clones) */
  workspaceDir: string;
  /** Local fast storage for temporary worktrees (emptyDir) */
  scratchDir: string;
}

export class RepoManager {
  private readonly workspaceDir: string;
  private readonly scratchDir: string;

  constructor(config?: Partial<RepoManagerConfig>) {
    this.workspaceDir = config?.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/data/workspace";
    this.scratchDir = config?.scratchDir ?? process.env.SCRATCH_DIR ?? "/data/scratch";
    fs.mkdirSync(this.scratchDir, { recursive: true });
  }

  /**
   * Get path to a repo in the workspace (NFS).
   * Repos are full clones at /workspace/{repoName}/
   */
  getRepoPath(repoName: string): string {
    return path.join(this.workspaceDir, repoName);
  }

  /**
   * Check if a repo exists in the workspace.
   */
  repoExists(repoName: string): boolean {
    const repoPath = this.getRepoPath(repoName);
    return fs.existsSync(path.join(repoPath, ".git"));
  }

  /**
   * List all available repos in the workspace.
   */
  listRepos(): string[] {
    try {
      return fs
        .readdirSync(this.workspaceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(this.workspaceDir, d.name, ".git")))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /**
   * Run git grep on a repo (works on NFS — sequential reads are tolerable).
   * Searches the working tree (HEAD) for the given pattern.
   *
   * Note: `git grep` exits with 1 when no matches are found (not an error)
   * and 128 on real failure (corrupt repo, bad cwd). Both are mapped to []
   * here, but real errors are logged to surface NFS / corruption issues.
   */
  gitGrep(repoName: string, pattern: string, pathSpec?: string[]): string[] {
    const repoPath = this.getRepoPath(repoName);
    const args = ["grep", "-l", "--", pattern];
    if (pathSpec?.length) {
      args.push("--", ...pathSpec);
    }

    const result = spawnSync("git", args, {
      cwd: repoPath,
      timeout: 30_000,
      encoding: "utf-8",
    });
    if (result.error) {
      console.warn(`[git grep] ${repoName}: spawn error: ${result.error.message}`);
      return [];
    }
    // status 1 = no match (normal); anything ≥2 indicates a real error.
    if (result.status !== null && result.status >= 2) {
      const stderr = result.stderr?.trim();
      console.warn(`[git grep] ${repoName}: exit ${result.status}${stderr ? `: ${stderr}` : ""}`);
      return [];
    }
    if (result.status !== 0) return []; // No matches
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  /**
   * Async version of gitGrep — runs in background, returns a Promise.
   * Used for parallel grep across multiple repos.
   */
  gitGrepAsync(repoName: string, pattern: string, pathSpec?: string[]): Promise<string[]> {
    const repoPath = this.getRepoPath(repoName);
    const args = ["grep", "-l", "--", pattern];
    if (pathSpec?.length) {
      args.push("--", ...pathSpec);
    }

    return new Promise((resolve) => {
      const proc = spawn("git", args, {
        cwd: repoPath,
        timeout: 30_000,
      });

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      // Without these, an EPIPE on a stdio stream would surface as an
      // unhandledError on the child and crash the worker process.
      proc.stdout.on("error", () => { /* swallowed; close handler decides */ });
      proc.stderr?.on("data", () => { /* drain to avoid backpressure */ });
      proc.stderr?.on("error", () => { /* swallow */ });
      proc.on("close", (code) => {
        if (code !== 0) return resolve([]);
        resolve(stdout.trim().split("\n").filter(Boolean));
      });
      proc.on("error", () => resolve([]));
    });
  }

  /**
   * Get the current HEAD commit hash for a repo.
   */
  getHeadCommit(repoName: string): string | null {
    const repoPath = this.getRepoPath(repoName);
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      timeout: 5_000,
      encoding: "utf-8",
    });
    if (result.error) {
      console.warn(`[git rev-parse] ${repoName}: spawn error: ${result.error.message}`);
      return null;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      console.warn(`[git rev-parse] ${repoName}: exit ${result.status}${stderr ? `: ${stderr}` : ""}`);
      return null;
    }
    return result.stdout.trim();
  }

  /**
   * Fetch a specific branch from remote origin.
   * Returns true if fetch succeeded.
   */
  fetchBranch(repoName: string, branch: string): boolean {
    const repoPath = this.getRepoPath(repoName);
    console.log(`[git fetch] ${repoName}: fetching origin ${branch}`);
    const result = spawnSync("git", ["fetch", "origin", branch], {
      cwd: repoPath,
      timeout: 60_000,
      encoding: "utf-8",
    });
    if (result.error) {
      console.warn(`[git fetch] ${repoName}: spawn error: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      console.warn(`[git fetch] ${repoName}: exit ${result.status}${stderr ? `: ${stderr}` : ""}`);
      return false;
    }
    return true;
  }

  /**
   * Resolve a git ref (branch name, FETCH_HEAD, tag, etc.) to a commit hash.
   */
  resolveRef(repoName: string, ref: string): string | null {
    const repoPath = this.getRepoPath(repoName);
    const result = spawnSync("git", ["rev-parse", ref], {
      cwd: repoPath,
      timeout: 5_000,
      encoding: "utf-8",
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  }

  /**
   * Compute the merge-base (fork point) between two refs.
   * Used to find where a feature branch diverged from the base branch.
   */
  getMergeBase(repoName: string, ref1: string, ref2: string): string | null {
    const repoPath = this.getRepoPath(repoName);
    const result = spawnSync("git", ["merge-base", ref1, ref2], {
      cwd: repoPath,
      timeout: 10_000,
      encoding: "utf-8",
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  }

  /**
   * List remote branches matching a pattern (e.g., "release/v*").
   * Returns sorted list (descending — newest version first).
   */
  listMatchingBranches(repoName: string, pattern: string): string[] {
    const repoPath = this.getRepoPath(repoName);
    const result = spawnSync(
      "git",
      ["branch", "-r", "--list", `origin/${pattern}`, "--sort=-version:refname"],
      { cwd: repoPath, timeout: 10_000, encoding: "utf-8" },
    );
    if (result.error || result.status !== 0) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^origin\//, ""))
      .filter(Boolean);
  }

  /**
   * Get diff between two refs, excluding specified directories.
   * Uses git pathspec exclusion syntax: ':!path/'
   */
  getDiffWithExcludes(repoName: string, base = "HEAD~1", head = "HEAD", excludeDirs: string[]): string {
    const repoPath = this.getRepoPath(repoName);
    const args = ["diff", base, head, "--"];

    // Add pathspec exclusions: ':!tests/' ':!test/' etc.
    for (const dir of excludeDirs) {
      args.push(`:!${dir}`);
    }

    const result = spawnSync("git", args, {
      cwd: repoPath,
      timeout: 30_000,
      encoding: "utf-8",
    });
    if (result.error) {
      console.warn(`[git diff] ${repoName}: spawn error: ${result.error.message}`);
      return "";
    }
    if (result.status !== 0) {
      // Distinguish a real failure (bad ref, repo corruption, timeout) from
      // an empty diff (status 0). Without this an unknown ref silently
      // returns "" and the pipeline reports "no symbols changed".
      const stderr = result.stderr?.trim();
      console.warn(`[git diff] ${repoName} ${base}..${head}: exit ${result.status}${stderr ? `: ${stderr}` : ""}`);
    }
    return result.stdout ?? "";
  }

  /**
   * Get diff between two refs (or working tree changes).
   */
  getDiff(repoName: string, base = "HEAD~1", head = "HEAD"): string {
    const repoPath = this.getRepoPath(repoName);
    const result = spawnSync("git", ["diff", base, head], {
      cwd: repoPath,
      timeout: 30_000,
      encoding: "utf-8",
    });
    if (result.error) {
      console.warn(`[git diff] ${repoName}: spawn error: ${result.error.message}`);
      return "";
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      console.warn(`[git diff] ${repoName} ${base}..${head}: exit ${result.status}${stderr ? `: ${stderr}` : ""}`);
    }
    return result.stdout ?? "";
  }

  /**
   * Create a temporary worktree on local fast storage (for ast-grep).
   * Returns the worktree path. Caller must call removeWorktree() when done.
   */
  createTaskWorktree(taskId: string, repoName: string, ref = "HEAD"): string {
    const repoPath = this.getRepoPath(repoName);
    const wtPath = path.join(this.scratchDir, taskId, repoName);

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    execFileSync("git", ["worktree", "add", "--detach", wtPath, ref], {
      cwd: repoPath,
      timeout: 60_000,
    });

    return wtPath;
  }

  /**
   * Remove a temporary worktree.
   *
   * `git worktree remove --force` can silently fail if the worktree is locked
   * (e.g. by a concurrent ast-grep process) or if the parent repo's worktree
   * registry is stale. Without this we'd accumulate orphaned directories on
   * the scratch volume and subsequent `worktree add` would fail with
   * "already exists". Falls back to `worktree prune` + filesystem rm.
   */
  removeWorktree(taskId: string, repoName: string): void {
    const repoPath = this.getRepoPath(repoName);
    const wtPath = path.join(this.scratchDir, taskId, repoName);

    const removeResult = spawnSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoPath,
      timeout: 30_000,
      encoding: "utf-8",
    });

    if (removeResult.status !== 0) {
      const stderr = removeResult.stderr?.toString().trim();
      console.warn(
        `[worktree] git worktree remove failed for ${repoName} (task ${taskId}): ${stderr || removeResult.error?.message || "unknown"}; falling back to prune + fs.rm`,
      );

      // Force-clean the registry entry, then nuke the directory directly.
      spawnSync("git", ["worktree", "prune"], {
        cwd: repoPath,
        timeout: 10_000,
      });

      try {
        if (fs.existsSync(wtPath)) {
          fs.rmSync(wtPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn(
          `[worktree] fs.rm fallback failed for ${wtPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Clean up empty task directory
    const taskDir = path.join(this.scratchDir, taskId);
    try {
      fs.rmdirSync(taskDir);
    } catch {
      // Not empty (other repos still in use), ignore
    }
  }

  /**
   * Execute a function with a temporary worktree, auto-cleanup on completion.
   */
  async withWorktree<T>(
    taskId: string,
    repoName: string,
    ref: string,
    fn: (worktreePath: string) => Promise<T>,
  ): Promise<T> {
    const wtPath = this.createTaskWorktree(taskId, repoName, ref);
    try {
      return await fn(wtPath);
    } finally {
      this.removeWorktree(taskId, repoName);
    }
  }

  /**
   * Read a file relative to the workspace root.
   * Returns null if file doesn't exist or read fails.
   */
  readFile(relativePath: string): string | null {
    const fullPath = path.join(this.workspaceDir, relativePath);
    try {
      return fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Check if a file exists relative to workspace root.
   */
  fileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(this.workspaceDir, relativePath));
  }

  /**
   * Clean up all worktrees for a given task (e.g., on timeout or error).
   */
  cleanupTask(taskId: string): void {
    const taskDir = path.join(this.scratchDir, taskId);
    if (!fs.existsSync(taskDir)) return;

    const repos = fs.readdirSync(taskDir);
    for (const repo of repos) {
      this.removeWorktree(taskId, repo);
    }
  }
}
