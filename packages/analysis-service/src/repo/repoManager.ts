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

import { execFileSync, spawnSync } from "node:child_process";
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

    if (result.status !== 0) return []; // No matches or error
    return result.stdout.trim().split("\n").filter(Boolean);
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
    if (result.status !== 0) return null;
    return result.stdout.trim();
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
   */
  removeWorktree(taskId: string, repoName: string): void {
    const repoPath = this.getRepoPath(repoName);
    const wtPath = path.join(this.scratchDir, taskId, repoName);

    spawnSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoPath,
    });

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
