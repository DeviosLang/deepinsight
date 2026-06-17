/**
 * Analysis API routes — POST /api/analyze, GET /api/analyze/:taskId
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { FastifyInstance } from "fastify";
import type { AnalysisTask, ChangeSpec, AnalysisOptions } from "@deepinsight/core";
import { runAnalysisPipeline, loadPipelineConfig } from "../orchestrator/pipeline.js";
import { RepoManager } from "../repo/repoManager.js";
import { renderMarkdown } from "../render/markdown.js";

// Persistent task store — writes to NFS for Pod restart survival
const TASK_STORE_DIR = path.join(process.env.WORKSPACE_DIR ?? "/data/workspace", ".deepinsight", "tasks");

// In-memory cache (fast reads) + file persistence (restart survival)
const tasks = new Map<string, AnalysisTask>();

// ─── Concurrency gate ──────────────────────────────────────────────────────
// Limits how many analyses can run concurrently in this Pod. Tasks beyond the
// limit stay in "queued" state and wait for a slot to free up. Without this,
// concurrent submissions all fire-and-forget at once: each spawns up to 4 pi
// workers, and the resulting ~16+ pi processes thrash the LLM session pool
// and (historically) raced on shared on-disk state.
//
// The limit is per-Pod. Across multiple Pods, the effective ceiling is
// MAX_CONCURRENT_TASKS × replicas. Set conservatively for a single Pod and
// scale horizontally for more throughput rather than raising this number.
const MAX_CONCURRENT_TASKS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_TASKS ?? "2", 10) || 2,
);
let runningCount = 0;
const waitQueue: Array<() => void> = [];

/** Wait until a concurrency slot is available, then claim it. */
function acquireSlot(): Promise<void> {
  if (runningCount < MAX_CONCURRENT_TASKS) {
    runningCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => {
      runningCount++;
      resolve();
    });
  });
}

/** Release a slot and wake up the next waiter (if any). */
function releaseSlot(): void {
  runningCount = Math.max(0, runningCount - 1);
  const next = waitQueue.shift();
  if (next) next();
}

console.log(`[concurrency] MAX_CONCURRENT_TASKS=${MAX_CONCURRENT_TASKS}`);

/** Initialize: load existing tasks from disk, clean up expired ones */
function loadTasksFromDisk(): void {
  try {
    fs.mkdirSync(TASK_STORE_DIR, { recursive: true });
    const files = fs.readdirSync(TASK_STORE_DIR).filter((f) => f.endsWith(".json"));
    const now = Date.now();
    const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const MAX_TASKS = 200;
    let loaded = 0;
    let cleaned = 0;
    let recovered = 0;

    for (const file of files) {
      try {
        const filePath = path.join(TASK_STORE_DIR, file);
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data) as unknown;

        // Validate before cast — corrupt or schema-skewed (old version) files
        // would otherwise crash later when `task.createdAt` is undefined.
        if (!isValidPersistedTask(parsed)) {
          console.warn(`[task-store] Skipping malformed task file ${file}`);
          continue;
        }
        const task = parsed as AnalysisTask;

        // Clean up tasks older than 30 days
        const completedTime = task.completedAt ? new Date(task.completedAt).getTime() : 0;
        const createdTime = new Date(task.createdAt).getTime();
        const taskAge = now - (completedTime || createdTime);

        if (taskAge > MAX_AGE_MS) {
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            // Logged, not silenced: persistent storage failures (NFS down,
            // permission drift) must not be invisible to operators.
            console.warn(`[task-store] Failed to delete expired task ${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
          cleaned++;
          continue;
        }

        // Recover orphaned tasks: a task persisted as "queued" or "running"
        // without a completedAt timestamp implies the process died mid-run.
        // Without this, polling clients would see "running" forever.
        //
        // Multi-Pod safety: in a multi-replica deployment, Pod B's startup
        // sees tasks owned by Pod A that are legitimately still running.
        // Use a generous staleness threshold (last update >2× the max
        // pipeline duration) so we only collect actual zombies, not live
        // tasks owned by sibling Pods. The pipeline tops out around 30 min
        // (4 pi workers × 900s timeout × 1 retry, run sequentially in the
        // worst case); 60 min as the orphan threshold leaves comfortable
        // margin while still cleaning up tasks killed by OOM/SIGKILL.
        const ORPHAN_AFTER_MS = 60 * 60 * 1000;
        const lastUpdateAt = createdTime; // best signal we have without per-step timestamps
        const isStale = now - lastUpdateAt > ORPHAN_AFTER_MS;
        if ((task.status === "queued" || task.status === "running") && !task.completedAt && isStale) {
          task.status = "failed";
          task.error = task.error ?? "Task orphaned by service restart";
          task.completedAt = new Date().toISOString();
          try {
            fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
          } catch (err) {
            console.warn(`[task-store] Failed to rewrite orphaned task ${task.taskId}:`, err);
          }
          recovered++;
        }

        tasks.set(task.taskId, task);
        loaded++;
      } catch {
        // Skip corrupted files
      }
    }

    // If still too many tasks, keep only the most recent MAX_TASKS
    if (tasks.size > MAX_TASKS) {
      const sorted = [...tasks.entries()].sort((a, b) => {
        const timeA = new Date(a[1].createdAt).getTime();
        const timeB = new Date(b[1].createdAt).getTime();
        return timeB - timeA; // newest first
      });
      const toKeep = new Set(sorted.slice(0, MAX_TASKS).map(([id]) => id));
      const toEvict: string[] = [];
      for (const [id] of tasks) {
        if (!toKeep.has(id)) toEvict.push(id);
      }
      for (const id of toEvict) {
        tasks.delete(id);
        try {
          fs.unlinkSync(path.join(TASK_STORE_DIR, `${id}.json`));
        } catch (err) {
          console.warn(`[task-store] Failed to delete LRU-evicted task ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        cleaned++;
      }
    }

    console.log(
      `[task-store] Loaded ${loaded} tasks, cleaned ${cleaned} expired, recovered ${recovered} orphaned (from ${TASK_STORE_DIR})`,
    );
  } catch {
    console.log(`[task-store] No existing tasks found, starting fresh`);
  }
}

/** Persist a task to disk */
function persistTask(task: AnalysisTask): void {
  try {
    fs.mkdirSync(TASK_STORE_DIR, { recursive: true });
    const filePath = path.join(TASK_STORE_DIR, `${task.taskId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
  } catch (err) {
    console.error(`[task-store] Failed to persist task ${task.taskId}:`, err);
  }
}

/**
 * Read a task from NFS by taskId. Returns null if absent or unreadable.
 *
 * Used by GET handlers to look up tasks owned by a different Pod (in
 * multi-replica deployments, the same Pod that wrote a task may not be
 * the one serving the GET). We deliberately do NOT cache the result in
 * the in-memory `tasks` Map — the owning Pod is still updating the file
 * (progress, status), so caching would surface stale data on later reads.
 */
function readTaskFromDisk(taskId: string): AnalysisTask | null {
  // Defensive: reject path-traversal-shaped ids before touching the FS.
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) return null;
  const filePath = path.join(TASK_STORE_DIR, `${taskId}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (!isValidPersistedTask(parsed)) return null;
    return parsed as AnalysisTask;
  } catch {
    // Malformed JSON, partial write race, permission drift, etc.
    return null;
  }
}

/**
 * Read all tasks from NFS directory. Returns the union of in-memory tasks
 * (which may be more recent for tasks this Pod is actively running) and
 * disk tasks (which include tasks owned by other Pods). When the same
 * taskId exists in both, the in-memory version wins.
 */
function readAllTasks(): AnalysisTask[] {
  const merged = new Map<string, AnalysisTask>();
  // Disk first: covers other Pods' tasks.
  try {
    const files = fs.readdirSync(TASK_STORE_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(TASK_STORE_DIR, file), "utf-8");
        const parsed = JSON.parse(data) as unknown;
        if (isValidPersistedTask(parsed)) {
          const t = parsed as AnalysisTask;
          merged.set(t.taskId, t);
        }
      } catch {
        // Skip unreadable / malformed files.
      }
    }
  } catch {
    // Directory missing — fall through with whatever's in memory.
  }
  // Memory wins: this Pod may have an in-flight task whose progress hasn't
  // been flushed to disk yet (between two persistTask calls).
  for (const [id, t] of tasks) {
    merged.set(id, t);
  }
  return [...merged.values()];
}

/**
 * Minimal shape check for a persisted task. Guards against corrupt JSON files
 * and stale schema versions on the NFS task store. Only validates fields the
 * task-store actually dereferences (taskId, status, createdAt, changes).
 */
function isValidPersistedTask(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.taskId !== "string" || o.taskId.length === 0) return false;
  if (typeof o.createdAt !== "string") return false;
  if (typeof o.status !== "string") return false;
  if (!["queued", "running", "completed", "failed"].includes(o.status)) return false;
  if (!Array.isArray(o.changes)) return false;
  return true;
}

// Load on startup
loadTasksFromDisk();

// Pod identifier surfaced in responses via the `X-Pod-Name` header so callers
// can detect which replica answered. Essential for debugging multi-Pod
// inconsistency: when GET returns stale state, the header tells you which
// Pod's in-memory cache went out of sync with NFS. K8s sets HOSTNAME to the
// Pod name; outside K8s falls back to OS hostname, then "unknown".
const POD_NAME = process.env.HOSTNAME ?? process.env.POD_NAME ?? "unknown";

/**
 * Resolve the freshest task view for a GET request.
 *
 * Failure mode this guards against:
 *   1. Pod A loads task X from NFS at startup while X.status === "running"
 *      (its owner is Pod B, mid-pipeline).
 *   2. Pod B finishes task X, writes NFS with status === "completed".
 *   3. GET hits Pod A → tasks.get(taskId) returns the stale "running" copy
 *      from step 1; the disk fallback is skipped because in-memory hit.
 *      → Caller sees "running" forever even though NFS has the final result.
 *
 * Fix: when in-memory state is non-terminal (queued/running), cross-check
 * NFS. If NFS is terminal (completed/failed), adopt the NFS version and
 * refresh in-memory so subsequent GETs to this Pod stay consistent.
 *
 * Cost: one extra `fs.readFileSync` per GET when status isn't terminal.
 * Acceptable — the file is < 100 KB and lives on NFS that's already cached
 * by the kernel. The terminal-state check ensures completed tasks (the hot
 * path) never pay this cost.
 */
function getFreshestTask(taskId: string): AnalysisTask | null {
  const inMemory = tasks.get(taskId);
  if (!inMemory) {
    return readTaskFromDisk(taskId);
  }
  // Terminal state — in-memory was written by this Pod's own pipeline, trust it.
  if (inMemory.status === "completed" || inMemory.status === "failed") {
    return inMemory;
  }
  // Non-terminal in-memory — could be a stale snapshot from startup. Check NFS.
  const onDisk = readTaskFromDisk(taskId);
  if (
    onDisk &&
    (onDisk.status === "completed" || onDisk.status === "failed") &&
    onDisk.completedAt
  ) {
    // NFS has the terminal version — adopt it and refresh local cache.
    tasks.set(taskId, onDisk);
    return onDisk;
  }
  return inMemory;
}

/**
 * Normalize the `repo` field of a ChangeSpec.
 *
 * Users may paste a full HTTP(S) git URL instead of the bare NFS directory
 * name that the pipeline expects. This function strips the protocol + host +
 * path prefix and the optional `.git` suffix so both forms are accepted:
 *
 *   "http://git.woa.com/vstation/image.git"  →  "image"
 *   "https://git.woa.com/vstation/image"     →  "image"
 *   "image"                                  →  "image"  (pass-through)
 *
 * SSH URLs (git@...) are deliberately NOT handled — the service uses HTTP
 * OAuth tokens, so SSH URLs should never appear. If they do, the string is
 * returned as-is and `repoExists()` will produce a clear "not found" error.
 */
function normalizeRepo(repo: string): string {
  if (repo.startsWith("http://") || repo.startsWith("https://")) {
    const lastSegment = repo.split("/").filter(Boolean).at(-1) ?? repo;
    return lastSegment.replace(/\.git$/i, "");
  }
  return repo;
}

interface AnalyzeBody {
  project: string;
  changes: ChangeSpec[];
  options?: AnalysisOptions;
}

/**
 * Compute a stable dedup key for a request.
 *
 * Key is scoped to (project, sorted changes, options) so that two POST
 * requests with identical intent map to the same string regardless of
 * array ordering. Used by the request-level idempotency check in the
 * POST /analyze handler.
 */
function requestDedupKey(project: string, changes: ChangeSpec[], options: AnalysisOptions): string {
  const changeKey = changes
    .map((c) => `${c.repo}::${c.branch ?? ""}::${c.commit ?? ""}::${c.base ?? ""}`)
    .sort()
    .join("|");
  // Stable JSON: sort keys so insertion order doesn't affect the key.
  const optKey = JSON.stringify(
    Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `${project}||${changeKey}||${optKey}`;
}

/** TTL for reusing a completed task. Requests arriving within this window
 *  for the same (project, changes, options) get the existing taskId back
 *  instead of triggering a fresh analysis. Set to 24 h. */
const COMPLETED_TASK_REUSE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Find an existing task that covers the same request.
 *
 * Returns the most-recent matching task when:
 *   - status is queued or running (always reusable — share the in-flight work), or
 *   - status is completed and the result is less than COMPLETED_TASK_REUSE_TTL_MS old.
 *
 * Failed tasks are never reused — the caller should be able to retry.
 *
 * Searches only the in-memory Map (≤ 200 entries, O(n) acceptable).
 * Cross-Pod dedup is left for a future iteration — it would require an
 * NFS scan on every POST which is unacceptable on the hot path.
 */
function findExistingTask(key: string): AnalysisTask | null {
  let best: AnalysisTask | null = null;
  const now = Date.now();

  for (const task of tasks.values()) {
    if (task.dedupKey !== key) continue;
    if (task.status === "failed") continue;

    if (task.status === "queued" || task.status === "running") {
      // In-flight tasks are always reusable; prefer the most recent one.
      if (!best || new Date(task.createdAt).getTime() > new Date(best.createdAt).getTime()) {
        best = task;
      }
      continue;
    }

    // status === "completed"
    const age = now - new Date(task.completedAt!).getTime();
    if (age <= COMPLETED_TASK_REUSE_TTL_MS) {
      if (!best || new Date(task.createdAt).getTime() > new Date(best.createdAt).getTime()) {
        best = task;
      }
    }
  }

  return best;
}

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
  const pipelineConfig = loadPipelineConfig();

  // Submit analysis task
  app.post<{ Body: AnalyzeBody }>("/analyze", async (req, reply) => {
    const { project, changes, options } = req.body;

    if (!project || !changes?.length) {
      return reply.status(400).send({ error: "project and changes are required" });
    }

    // Normalize repo fields: accept full HTTP(S) URLs as well as bare names.
    const normalizedChanges = changes.map((c) => ({ ...c, repo: normalizeRepo(c.repo) }));
    const normalizedOptions = options ?? {};

    // ── Request-level idempotency ───────────────────────────────────────────
    // If a task with the same (project, changes, options) is already queued,
    // running, or recently completed (< 24 h), return its taskId directly.
    // This prevents duplicate analysis runs for the same branch push event
    // and lets CI pipelines safely re-POST without burning extra LLM quota.
    const dedupKey = requestDedupKey(project, normalizedChanges, normalizedOptions);
    const existing = findExistingTask(dedupKey);
    if (existing) {
      reply.header("X-Pod-Name", POD_NAME);
      return reply.status(200).send({
        taskId: existing.taskId,
        status: existing.status,
        pollUrl: `/api/analyze/${existing.taskId}`,
        reused: true,
      });
    }

    const taskId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const task: AnalysisTask = {
      taskId,
      project,
      status: "queued",
      changes: normalizedChanges,
      options: normalizedOptions,
      dedupKey,
      createdAt: new Date().toISOString(),
    };

    tasks.set(taskId, task);
    persistTask(task);

    // Run analysis in background (fire-and-forget).
    // The .catch handler is the LAST line of defense for the task state machine:
    // if it doesn't set completedAt, polling clients see a "failed" task with
    // no terminal timestamp and cannot distinguish it from a stuck task.
    startAnalysis(task, pipelineConfig).catch((err) => {
      app.log.error({ taskId, err }, "Analysis failed");
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = task.completedAt ?? new Date().toISOString();
      persistTask(task);
    });

    return reply.status(202).send({
      taskId,
      status: "queued",
      pollUrl: `/api/analyze/${taskId}`,
    });
  });

  // Query task status
  app.get<{ Params: { taskId: string }; Querystring: { format?: string } }>(
    "/analyze/:taskId",
    async (req, reply) => {
      const { taskId } = req.params;
      // Always surface which Pod answered — invaluable for debugging multi-Pod
      // inconsistency. Set BEFORE any early return so 404s also carry it.
      reply.header("X-Pod-Name", POD_NAME);
      // Memory first (this Pod's own running tasks have the freshest state).
      // Cross-check NFS when in-memory state is non-terminal — see
      // getFreshestTask docstring for the failure mode this guards.
      const task = getFreshestTask(taskId);

      if (!task) {
        return reply.status(404).send({ error: "Task not found" });
      }

      // Optional Markdown rendering for human-friendly review.
      // Renderer tolerates partial/unfinished tasks (it'll just emit fewer
      // sections), so we don't gate on `task.status === "completed"`.
      const format = (req.query?.format ?? "").toLowerCase();
      if (format === "markdown" || format === "md") {
        // Renderer accepts the full task envelope or bare result.
        // Cast to Record<string, unknown> for the loose-typed renderer input.
        const md = renderMarkdown(task as unknown as Record<string, unknown>);
        return reply
          .type("text/markdown; charset=utf-8")
          .send(md);
      }

      return task;
    },
  );

  // Cancel task
  app.delete<{ Params: { taskId: string } }>("/analyze/:taskId", async (req, reply) => {
    const { taskId } = req.params;
    // Cancellation only makes sense for tasks owned by this Pod — only this
    // Pod's startAnalysis can observe the in-memory status flip and bail
    // out. Tasks owned by other Pods would need cross-Pod signalling
    // (cancel-flag in the JSON file polled by the owner) which isn't built
    // yet; for now, surface a clear 409 instead of silently failing.
    const task = tasks.get(taskId);

    if (!task) {
      // Distinguish "doesn't exist" from "owned by another Pod" so callers
      // know whether to retry against a different replica.
      if (readTaskFromDisk(taskId)) {
        return reply.status(409).send({
          error: "Task is owned by another Pod and cannot be cancelled from here",
        });
      }
      return reply.status(404).send({ error: "Task not found" });
    }

    if (task.status === "completed" || task.status === "failed") {
      return reply.status(409).send({ error: "Task already finished" });
    }

    // Flip to "failed" with completedAt so polling clients see a terminal
    // state. If the task is currently waiting on the concurrency gate,
    // startAnalysis will detect this status when the slot is granted and
    // skip the pipeline entirely.
    task.status = "failed";
    task.error = "Cancelled by user";
    task.completedAt = new Date().toISOString();
    persistTask(task);
    return { taskId, status: "cancelled" };
  });

  // List all tasks (summary view, no full result payload)
  app.get("/tasks", async (req, reply) => {
    reply.header("X-Pod-Name", POD_NAME);
    const query = req.query as Record<string, string>;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const status = query.status; // optional filter: queued|running|completed|failed

    // Read from NFS so multi-Pod deployments see all tasks, not just the
    // ones this Pod is running. In-memory state takes precedence for tasks
    // this Pod owns (their progress is fresher than the last persistTask).
    const all = readAllTasks();
    const allTasks = all
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((t) => !status || t.status === status)
      .slice(0, limit);

    return {
      total: all.length,
      returned: allTasks.length,
      tasks: allTasks.map((t) => ({
        taskId: t.taskId,
        project: t.project,
        status: t.status,
        changes: t.changes,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        error: t.error,
        progress: t.progress,
        // Omit full result to keep response lightweight
        hasResult: !!t.result,
      })),
    };
  });

  // ─── GET /repos ───────────────────────────────────────────────────────────
  // Returns the list of available repos with role annotations from config.
  //
  // Supports two project config shapes:
  //   (A) New list form: repos: [{name, url, role}, ...]
  //   (B) Legacy map form: repos: {entry_points: [...], sinks: [...]}
  //       — used by the deployed config; NFS names are the source of truth.
  //
  // Response shape:
  //   {
  //     repos: [
  //       { name: "vstation_image", role: "entry_point" },
  //       { name: "vstation_frame" },
  //       ...
  //     ]
  //   }
  app.get("/repos", async (_req, reply) => {
    reply.header("X-Pod-Name", POD_NAME);

    // Build role map from project config (best-effort; config may be absent).
    // Supports both list (new) and map/legacy formats.
    const roleMap = new Map<string, string>(); // name → role
    const urlMap = new Map<string, string>();  // name → url (list format only)
    const projectConfigPath = process.env.PROJECT_CONFIG_PATH ?? "/etc/deepinsight/project.yml";
    try {
      const rawYaml = fs.readFileSync(projectConfigPath, "utf-8");
      const config = YAML.parse(rawYaml) as Record<string, unknown>;
      const rawRepos = config.repos;

      if (Array.isArray(rawRepos)) {
        // Shape (A): [{name, url?, role?}, ...]
        for (const item of rawRepos) {
          if (typeof item !== "object" || item === null) continue;
          const r = item as Record<string, unknown>;
          if (typeof r.name !== "string") continue;
          if (typeof r.role === "string") roleMap.set(r.name, r.role);
          if (typeof r.url === "string") urlMap.set(r.name, r.url);
        }
      } else if (typeof rawRepos === "object" && rawRepos !== null) {
        // Shape (B): {entry_points: [...], sinks: [...]}
        const m = rawRepos as Record<string, unknown>;
        if (Array.isArray(m.entry_points)) {
          for (const x of m.entry_points) roleMap.set(String(x), "entry_point");
        }
        if (Array.isArray(m.sinks)) {
          for (const x of m.sinks) roleMap.set(String(x), "sink");
        }
      }
    } catch {
      // Config absent or unreadable — return NFS list without role annotations.
    }

    // All repos available on NFS — this is the authoritative list of what
    // `changes[].repo` can reference.
    const repoManager = new RepoManager({ workspaceDir: pipelineConfig.workspaceDir });
    const nfsNames = repoManager.listRepos().sort();

    const repos = nfsNames.map((name) => {
      // Prefer URL from config (list format); fall back to git remote (strips credentials).
      const url = urlMap.get(name) ?? repoManager.getRemoteUrl(name) ?? undefined;
      return {
        name,
        ...(url ? { url } : {}),
        ...(roleMap.has(name) ? { role: roleMap.get(name) } : {}),
      };
    });

    return { repos };
  });
}

/**
 * Execute analysis pipeline, gated by the concurrency semaphore.
 *
 * Lifecycle:
 *   queued → (await slot) → running → completed/failed
 *
 * If the task is cancelled while waiting in the queue (status flipped to
 * "failed" by DELETE /api/analyze/:taskId), we honor that and skip the
 * pipeline entirely — but still call releaseSlot() to wake the next waiter,
 * since acquireSlot already incremented runningCount on our behalf.
 */
async function startAnalysis(task: AnalysisTask, pipelineConfig: ReturnType<typeof loadPipelineConfig>): Promise<void> {
  // Wait for a concurrency slot. While waiting, status stays "queued" so
  // polling clients can see the task is gated rather than mid-pipeline.
  await acquireSlot();

  try {
    // Cancelled while queued — bail out without running the pipeline.
    if (task.status === "failed") {
      return;
    }

    task.status = "running";
    task.progress = { step: 0, stepName: "初始化", reposScanned: 0, reposTotal: 0 };
    persistTask(task);

    const result = await runAnalysisPipeline(task, pipelineConfig);

    if (result) {
      task.result = result;
      task.status = "completed";
    } else if (!task.error) {
      task.status = "failed";
      task.error = "Analysis returned no result";
    } else {
      task.status = "failed";
    }

    task.completedAt = new Date().toISOString();
    persistTask(task);
  } finally {
    releaseSlot();
  }
}
