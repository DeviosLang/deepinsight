/**
 * Analysis API routes — POST /api/analyze, GET /api/analyze/:taskId
 */

import type { FastifyInstance } from "fastify";
import type { AnalysisTask, ChangeSpec, AnalysisOptions } from "@deepinsight/core";

// In-memory task store (Phase 1a: replace with persistent store later)
const tasks = new Map<string, AnalysisTask>();

interface AnalyzeBody {
  project: string;
  changes: ChangeSpec[];
  options?: AnalysisOptions;
}

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
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

    // TODO: Phase 1a — synchronous execution
    // TODO: Phase 1b — async queue + background processing
    startAnalysis(task).catch((err) => {
      app.log.error({ taskId, err }, "Analysis failed");
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    });

    return reply.status(202).send({
      taskId,
      status: "queued",
      pollUrl: `/api/analyze/${taskId}`,
    });
  });

  // Query task status
  app.get<{ Params: { taskId: string } }>("/analyze/:taskId", async (req, reply) => {
    const { taskId } = req.params;
    const task = tasks.get(taskId);

    if (!task) {
      return reply.status(404).send({ error: "Task not found" });
    }

    return task;
  });

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
}

/**
 * Execute analysis (Phase 1a: synchronous, single worker)
 */
async function startAnalysis(task: AnalysisTask): Promise<void> {
  task.status = "running";
  task.progress = { step: 0, stepName: "初始化", reposScanned: 0, reposTotal: 0 };

  // TODO: Implement analysis pipeline
  // 1. Load project config
  // 2. Fetch diff from git
  // 3. Pre-filter (coarse + fine)
  // 4. Spawn pi worker(s)
  // 5. Merge results
  // 6. Return report

  // Placeholder: mark completed after setup
  task.status = "completed";
  task.completedAt = new Date().toISOString();
}
