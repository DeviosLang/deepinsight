/**
 * Analysis API routes — POST /api/analyze, GET /api/analyze/:taskId
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AnalysisTask, ChangeSpec, AnalysisOptions } from "@deepinsight/core";
import { runAnalysisPipeline, loadPipelineConfig } from "../orchestrator/pipeline.js";
import { renderMarkdown } from "../render/markdown.js";

// Persistent task store — writes to NFS for Pod restart survival
const TASK_STORE_DIR = path.join(process.env.WORKSPACE_DIR ?? "/data/workspace", ".deepinsight", "tasks");

// In-memory cache (fast reads) + file persistence (restart survival)
const tasks = new Map<string, AnalysisTask>();

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
        if ((task.status === "queued" || task.status === "running") && !task.completedAt) {
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

interface AnalyzeBody {
  project: string;
  changes: ChangeSpec[];
  options?: AnalysisOptions;
}

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
  const pipelineConfig = loadPipelineConfig();

  // Submit analysis task
  app.post<{ Body: AnalyzeBody }>("/analyze", async (req, reply) => {
    const { project, changes, options } = req.body;

    if (!project || !changes?.length) {
      return reply.status(400).send({ error: "project and changes are required" });
    }

    const taskId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const task: AnalysisTask = {
      taskId,
      project,
      status: "queued",
      changes,
      options: options ?? {},
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
      const task = tasks.get(taskId);

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
    const task = tasks.get(taskId);

    if (!task) {
      return reply.status(404).send({ error: "Task not found" });
    }

    if (task.status === "completed" || task.status === "failed") {
      return reply.status(409).send({ error: "Task already finished" });
    }

    task.status = "failed";
    task.error = "Cancelled by user";
    return { taskId, status: "cancelled" };
  });

  // List all tasks (summary view, no full result payload)
  app.get("/tasks", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const status = query.status; // optional filter: queued|running|completed|failed

    const allTasks = [...tasks.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((t) => !status || t.status === status)
      .slice(0, limit);

    return {
      total: tasks.size,
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
}

/**
 * Execute analysis pipeline.
 */
async function startAnalysis(task: AnalysisTask, pipelineConfig: ReturnType<typeof loadPipelineConfig>): Promise<void> {
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
}
