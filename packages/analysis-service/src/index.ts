/**
 * DeepInsight Analysis Service — Entry Point
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { analyzeRoutes } from "./api/analyze.js";
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

export { server };
