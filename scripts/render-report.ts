#!/usr/bin/env -S npx tsx
/**
 * render-report.ts — Render an AnalysisResult JSON to Markdown.
 *
 * Usage:
 *   npx tsx scripts/render-report.ts <input>           # writes to stdout
 *   npx tsx scripts/render-report.ts <input> -o out.md # writes to file
 *
 * Where <input> is one of:
 *   - A path to a JSON file (e.g. /tmp/task.json)
 *   - "-" to read from stdin
 *   - A task-id (e.g. analysis-1780408494272-wyqmq5)
 *     → resolved against $WORKSPACE_DIR/.deepinsight/tasks/<id>.json
 *     (default: /data/workspace, override with WORKSPACE_DIR env var or --workspace)
 *
 * The renderer accepts either the full task envelope (with `result` + `changes`
 * + timestamps) or the bare AnalysisResult; it picks up whatever is provided.
 */

import * as fs from "node:fs";
import * as path from "node:path";
// Use the compiled dist output rather than src/ so this CLI works inside the
// production image (which only ships dist/), and locally after `pnpm -r build`.
// If you're iterating on the renderer, run `pnpm --filter @deepinsight/analysis-service build`
// first, or call renderMarkdown directly from a vitest test.
import { renderMarkdown } from "../packages/analysis-service/dist/render/markdown.js";

interface CliArgs {
  input: string;
  output?: string;
  workspaceDir: string;
  noMeta: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: "",
    workspaceDir: process.env.WORKSPACE_DIR ?? "/data/workspace",
    noMeta: false,
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-o" || a === "--output") {
      args.output = rest[++i];
    } else if (a === "--workspace") {
      args.workspaceDir = rest[++i];
    } else if (a === "--no-meta") {
      args.noMeta = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith("-") || a === "-") {
      // First positional argument is the input.
      // Note: a single "-" is treated as stdin, not as a flag.
      if (!args.input) args.input = a;
      else {
        console.error(`Unexpected extra argument: ${a}`);
        process.exit(2);
      }
    } else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!args.input) {
    console.error("Error: missing <input>");
    printHelp();
    process.exit(2);
  }

  return args;
}

function printHelp(): void {
  console.error(`Usage: npx tsx scripts/render-report.ts <input> [options]

Inputs:
  <path>             Path to JSON file (task envelope or AnalysisResult)
  -                  Read JSON from stdin
  <task-id>          Resolve from \$WORKSPACE_DIR/.deepinsight/tasks/<id>.json

Options:
  -o, --output FILE  Write output to file instead of stdout
  --workspace DIR    Workspace dir for task-id lookup (default: \$WORKSPACE_DIR or /data/workspace)
  --no-meta          Omit run-metadata section
  -h, --help         Show help
`);
}

function readStdin(): string {
  // Synchronously slurp stdin. Node sets fd=0 to non-blocking on TTY by default,
  // which would make readFileSync(0) hang indefinitely if there's no piped input
  // — but if the user passed "-" they should always be piping.
  return fs.readFileSync(0, "utf-8");
}

function loadInput(args: CliArgs): { raw: string; source: string } {
  const inp = args.input;

  if (inp === "-") {
    return { raw: readStdin(), source: "stdin" };
  }

  // Try as path first (most common case)
  if (fs.existsSync(inp)) {
    return { raw: fs.readFileSync(inp, "utf-8"), source: inp };
  }

  // Try as task-id under workspace.
  // Task-IDs always start with "analysis-" by convention, so be defensive
  // about other strings landing here.
  if (inp.startsWith("analysis-")) {
    const taskFile = path.join(args.workspaceDir, ".deepinsight", "tasks", `${inp}.json`);
    if (fs.existsSync(taskFile)) {
      return { raw: fs.readFileSync(taskFile, "utf-8"), source: taskFile };
    }
    console.error(`Error: task-id "${inp}" not found at ${taskFile}`);
    process.exit(1);
  }

  console.error(`Error: input not found: ${inp} (not a file, not a task-id)`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv);
  const { raw, source } = loadInput(args);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: failed to parse JSON from ${source}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error(`Error: expected JSON object from ${source}, got ${typeof parsed}`);
    process.exit(1);
  }

  const md = renderMarkdown(parsed as Record<string, unknown>, {
    includeMeta: !args.noMeta,
  });

  if (args.output) {
    fs.writeFileSync(args.output, md, "utf-8");
    console.error(`[render] wrote ${md.length} chars → ${args.output}`);
  } else {
    process.stdout.write(md);
  }
}

main();
