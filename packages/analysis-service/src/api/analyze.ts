/**
 * Analysis API routes — POST /api/analyze, GET /api/analyze/:taskId
 */

import type { FastifyInstance } from "fastify";
import type { AnalysisTask, ChangeSpec, AnalysisOptions } from "@deepinsight/core";
import { runAnalysisPipeline, loadPipelineConfig } from "../orchestrator/pipeline.js";

// In-memory task store (Phase 1a: replace with persistent store later)
const tasks = new Map<string, AnalysisTask>();

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

    // Phase 1a: run analysis in background (fire-and-forget)
    startAnalysis(task, pipelineConfig).catch((err) => {
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
 * Execute analysis pipeline.
 */
async function startAnalysis(task: AnalysisTask, pipelineConfig: ReturnType<typeof loadPipelineConfig>): Promise<void> {
  task.status = "running";
  task.progress = { step: 0, stepName: "初始化", reposScanned: 0, reposTotal: 0 };

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
}
