/**
 * DeepInsight Analysis Service — Entry Point
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { analyzeRoutes, initiateShutdown } from "./api/analyze.js";
import { healthRoutes } from "./api/health.js";

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  },
});

// Plugins
await server.register(cors, { origin: true });

// Routes
await server.register(healthRoutes);
await server.register(analyzeRoutes, { prefix: "/api" });

// Start
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await server.listen({ port, host });
  server.log.info(`DeepInsight analysis service running on ${host}:${port}`);
} catch (err) {
  server.log.fatal(err);
  process.exit(1);
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────
// K8s sends SIGTERM on pod termination. Without a handler the Node process
// ignores the signal and idles for the full terminationGracePeriodSeconds
// before SIGKILL — for this service that was 900s, so every rollout blocked
// ~15 min per pod.
//
// On SIGTERM we:
//   1. initiateShutdown() — abort the shared controller, which kills in-flight
//      pi child processes; drain queued/running tasks to "failed" on disk.
//   2. server.close() — stop accepting new HTTP connections, drain in-flight
//      requests. (Background analysis promises are already aborting via #1.)
//   3. Hard exit after a soft timeout so we never approach the k8s grace
//      period. 30s is ample: pi children die on SIGTERM immediately, and the
//      only remaining work is flushing task state to NFS.
const SHUTDOWN_SOFT_TIMEOUT_MS = 30_000;

async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, `Received ${signal}, shutting down`);

  // Hard exit if graceful shutdown somehow stalls past the soft timeout.
  // Guarantees we exit well before k8s's SIGKILL (deployment sets 60s grace).
  // Only armed AFTER a signal arrives — a top-level timer would kill the
  // server 30s after boot. .unref() so it never keeps the loop alive.
  const forceExit = setTimeout(() => {
    server.log.error("Shutdown soft timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_SOFT_TIMEOUT_MS).unref();

  // Abort in-flight analysis + mark queued/running tasks as failed on disk.
  initiateShutdown(`服务收到 ${signal}，正在关闭`);

  // Stop accepting new requests; resolve once in-flight HTTP requests drain.
  // Intentionally NOT awaited with the soft timeout — server.close() resolves
  // quickly for a service whose handlers are short (the long work is the
  // background pipeline, already aborting).
  try {
    await server.close();
  } catch (err) {
    server.log.warn({ err }, "Error during server.close()");
  }

  clearTimeout(forceExit);
  server.log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

export { server };
