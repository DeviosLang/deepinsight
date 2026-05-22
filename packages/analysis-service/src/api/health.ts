/**
 * Health check routes — /healthz and /readyz
 */

import { statSync } from "node:fs";
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — process is alive
  app.get("/healthz", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Readiness — dependencies available
  app.get("/readyz", async (_req, reply) => {
    const checks = {
      workspace: checkWorkspace(),
      scratch: checkScratch(),
    };

    const allOk = Object.values(checks).every((v) => v);

    if (!allOk) {
      return reply.status(503).send({ status: "not_ready", checks });
    }

    return { status: "ready", checks };
  });
}

function checkWorkspace(): boolean {
  const workspaceDir = process.env.WORKSPACE_DIR ?? "/tmp/deepinsight-workspace";
  try {
    statSync(workspaceDir);
    return true;
  } catch {
    return false;
  }
}

function checkScratch(): boolean {
  const scratchDir = process.env.SCRATCH_DIR ?? "/tmp/deepinsight-scratch";
  try {
    statSync(scratchDir);
    return true;
  } catch {
    return false;
  }
}
