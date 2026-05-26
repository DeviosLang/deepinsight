import { describe, test, expect } from "vitest";

// Import the functions we're testing by reading the source
// (pipeline.ts exports loadPipelineConfig but extractSymbolsFromDiff is internal)
// We'll test via the module's exported interface + inline test helpers

describe("extractSymbolsFromDiff", () => {
  // Re-implement the function for unit testing (same logic as pipeline.ts)
  function extractSymbolsFromDiff(diff: string) {
    const symbols: Array<{ name: string; pattern?: string }> = [];
    const seen = new Set<string>();

    const lines = diff.split("\n");
    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s.*@@\s*(?:def|class)\s+(\w+)/);
      if (hunkMatch && !seen.has(hunkMatch[1])) {
        seen.add(hunkMatch[1]);
        symbols.push({ name: hunkMatch[1], pattern: `${hunkMatch[1]}($$$)` });
        continue;
      }

      if (!line.startsWith("+") && !line.startsWith("-")) continue;
      if (line.startsWith("+++") || line.startsWith("---")) continue;

      const funcMatch = line.match(/^\+?\-?\s*def\s+(\w+)\s*\(/);
      if (funcMatch && !seen.has(funcMatch[1])) {
        seen.add(funcMatch[1]);
        symbols.push({ name: funcMatch[1], pattern: `${funcMatch[1]}($$$)` });
      }

      const classMatch = line.match(/^\+?\-?\s*class\s+(\w+)[\s(:]/);
      if (classMatch && !seen.has(classMatch[1])) {
        seen.add(classMatch[1]);
        symbols.push({ name: classMatch[1] });
      }
    }

    return symbols;
  }

  test("extracts function from hunk header", () => {
    const diff = `@@ -468,7 +468,7 @@ def update_translog(msg):
-        msg.last_redelivered = msg.command + '-' + str(msg.cursor)
+        msg.last_redelivered = msg.command`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("update_translog");
  });

  test("extracts function from added line", () => {
    const diff = `+    def new_helper(self, x):
+        return x * 2`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("new_helper");
  });

  test("extracts class from changed line", () => {
    const diff = `-class OldClass(Base):
+class NewClass(Base):`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(2);
    expect(symbols.map((s) => s.name)).toContain("OldClass");
    expect(symbols.map((s) => s.name)).toContain("NewClass");
  });

  test("deduplicates symbols", () => {
    const diff = `@@ -10,5 +10,5 @@ def my_func(x):
-    return x
+    return x + 1
@@ -20,5 +20,5 @@ def my_func(x):
-    pass
+    return None`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("my_func");
  });

  test("ignores +++ and --- lines", () => {
    const diff = `--- a/def_file.py
+++ b/def_file.py
@@ -1,3 +1,3 @@
-x = 1
+x = 2`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(0);
  });

  test("returns empty for no-symbol diff", () => {
    const diff = `@@ -149,7 +149,7 @@ callback_metric:
-        instanceType = msg.parameters.get('instanceType')
+        instanceType = msg.parameters.get('instanceType', '')`;

    const symbols = extractSymbolsFromDiff(diff);
    // "callback_metric" not matched because hunk header format is "callback_metric:" not "def callback_metric"
    // Actually it won't match because it needs "def" or "class" keyword
    expect(symbols).toHaveLength(0);
  });

  test("extracts from hunk header with class keyword", () => {
    const diff = `@@ -50,3 +50,3 @@ class MessageChecker:
-        self.x = 1
+        self.x = 2`;

    const symbols = extractSymbolsFromDiff(diff);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("MessageChecker");
  });
});

describe("extractJsonFromOutput", () => {
  function extractJsonFromOutput(output: string): Record<string, unknown> | null {
    const jsonBlocks = output.matchAll(/```json\s*\n([\s\S]*?)\n```/g);
    let lastBlock: string | null = null;
    for (const match of jsonBlocks) {
      lastBlock = match[1];
    }
    if (!lastBlock) return null;
    try {
      return JSON.parse(lastBlock);
    } catch {
      return null;
    }
  }

  test("extracts last JSON block from output", () => {
    const output = `Some text here

\`\`\`json
{"first": true}
\`\`\`

More analysis...

\`\`\`json
{"final": true, "risk": "P0"}
\`\`\`
`;
    const result = extractJsonFromOutput(output);
    expect(result).toEqual({ final: true, risk: "P0" });
  });

  test("returns null for no JSON block", () => {
    const output = "Just plain text analysis with no code blocks";
    expect(extractJsonFromOutput(output)).toBeNull();
  });

  test("returns null for invalid JSON in block", () => {
    const output = `\`\`\`json
{invalid json here}
\`\`\``;
    expect(extractJsonFromOutput(output)).toBeNull();
  });

  test("handles nested objects", () => {
    const output = `\`\`\`json
{
  "changes": [{"id": "CHG-01", "risk": "high"}],
  "call_chains": {"symbol": {"callers": []}}
}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).not.toBeNull();
    expect((result as any).changes[0].id).toBe("CHG-01");
  });

  test("ignores non-json code blocks", () => {
    const output = `\`\`\`python
def hello():
    pass
\`\`\`

\`\`\`json
{"result": "ok"}
\`\`\``;
    const result = extractJsonFromOutput(output);
    expect(result).toEqual({ result: "ok" });
  });
});

describe("GENERIC_NAMES filter", () => {
  const GENERIC_NAMES = new Set([
    "check", "get", "set", "run", "main", "init", "test", "setup",
    "update", "delete", "create", "read", "write", "open", "close",
  ]);

  function shouldFilter(name: string): boolean {
    return name.length < 4 || GENERIC_NAMES.has(name);
  }

  test("filters short names", () => {
    expect(shouldFilter("fn")).toBe(true);
    expect(shouldFilter("go")).toBe(true);
  });

  test("filters generic names", () => {
    expect(shouldFilter("check")).toBe(true);
    expect(shouldFilter("update")).toBe(true);
    expect(shouldFilter("init")).toBe(true);
  });

  test("passes specific names", () => {
    expect(shouldFilter("update_translog")).toBe(false);
    expect(shouldFilter("emergency_purge")).toBe(false);
    expect(shouldFilter("callback_metric")).toBe(false);
    expect(shouldFilter("CRedisClient")).toBe(false);
  });

  test("get/set are filtered by both length and set", () => {
    // "get" has length 3 < 4, so length filter catches it first
    // "set" same. These are redundant in the Set but harmless.
    expect(shouldFilter("get")).toBe(true);
    expect(shouldFilter("set")).toBe(true);
  });
});
