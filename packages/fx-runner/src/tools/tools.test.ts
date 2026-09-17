// @effect-diagnostics nodeBuiltinImport:off - tests exercise the real filesystem in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeEditFileTool, makeListDirTool, makeReadFileTool, makeWriteFileTool } from "./files.ts";
import { resolveWithinRoot } from "./paths.ts";
import { makeGlobTool, makeGrepTool } from "./search.ts";
import { makeShellTool } from "./shell.ts";
import type { HostTool } from "./types.ts";

let root: string;
const run = (tool: HostTool, input: unknown, signal = new AbortController().signal) =>
  Promise.resolve(tool.execute(input, { signal }));

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fx-runner-tools-"));
  NodeFS.mkdirSync(NodePath.join(root, "src", "nested"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "node_modules", "dep"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "src", "a.ts"), "const alpha = 1;\nconst Beta = 2;\n");
  NodeFS.writeFileSync(NodePath.join(root, "src", "nested", "b.ts"), "export const beta = 3;\n");
  NodeFS.writeFileSync(NodePath.join(root, "node_modules", "dep", "index.js"), "beta\n");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "# hello\n");
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("resolves relative paths inside the root and rejects escapes", () => {
    expect(resolveWithinRoot(root, "src/a.ts")).toBe(NodePath.join(root, "src", "a.ts"));
    expect(resolveWithinRoot(root, ".")).toBe(NodePath.resolve(root));
    expect(() => resolveWithinRoot(root, "../outside")).toThrow(/escapes the workspace root/);
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(/escapes the workspace root/);
  });
});

describe("readFile", () => {
  it("returns numbered lines and pages with startLine/lineCount", async () => {
    const tool = makeReadFileTool(root);
    expect(await run(tool, { path: "src/a.ts" })).toBe(
      "1\tconst alpha = 1;\n2\tconst Beta = 2;\n3\t",
    );
    expect(await run(tool, { path: "src/a.ts", startLine: 2, lineCount: 1 })).toBe(
      "2\tconst Beta = 2;\n[1 more lines]",
    );
  });

  it("rejects directories and malformed input", async () => {
    const tool = makeReadFileTool(root);
    await expect(run(tool, { path: "src" })).rejects.toThrow(/Not a file/);
    await expect(run(tool, { path: 42 })).rejects.toThrow();
  });
});

describe("writeFile and editFile", () => {
  it("writes through new directories, then edits exactly one occurrence", async () => {
    const write = makeWriteFileTool(root);
    const edit = makeEditFileTool(root);
    expect(await run(write, { path: "deep/new/file.txt", content: "one two one" })).toBe(
      "Wrote 11 bytes to deep/new/file.txt",
    );
    await expect(
      run(edit, { path: "deep/new/file.txt", oldString: "one", newString: "1" }),
    ).rejects.toThrow(/more than once/);
    await expect(
      run(edit, { path: "deep/new/file.txt", oldString: "three", newString: "3" }),
    ).rejects.toThrow(/not found/);
    expect(await run(edit, { path: "deep/new/file.txt", oldString: "two", newString: "2" })).toBe(
      "Edited deep/new/file.txt",
    );
    expect(NodeFS.readFileSync(NodePath.join(root, "deep/new/file.txt"), "utf8")).toBe("one 2 one");
  });
});

describe("listDir", () => {
  it("lists sorted entries with directories marked", async () => {
    const tool = makeListDirTool(root);
    expect(await run(tool, {})).toBe("README.md\nnode_modules/\nsrc/");
    expect(await run(tool, { path: "src" })).toBe("a.ts\nnested/");
  });
});

describe("grep", () => {
  it("finds literal matches, honors include and case-insensitivity, skips node_modules", async () => {
    const tool = makeGrepTool(root);
    expect(await run(tool, { pattern: "beta" })).toBe("src/nested/b.ts:1:export const beta = 3;");
    expect(await run(tool, { pattern: "beta", caseInsensitive: true })).toBe(
      "src/a.ts:2:const Beta = 2;\nsrc/nested/b.ts:1:export const beta = 3;",
    );
    expect(await run(tool, { pattern: "beta", include: "src/*.ts", caseInsensitive: true })).toBe(
      "src/a.ts:2:const Beta = 2;",
    );
    expect(await run(tool, { pattern: "nothing-here" })).toBe("[no matches]");
  });

  it("stops at maxResults", async () => {
    const tool = makeGrepTool(root);
    expect(await run(tool, { pattern: "const", maxResults: 1 })).toBe(
      "src/a.ts:1:const alpha = 1;\n[stopped at 1 matches]",
    );
  });
});

describe("glob", () => {
  it("matches patterns relative to the root and skips node_modules", async () => {
    const tool = makeGlobTool(root);
    expect(await run(tool, { pattern: "**/*.ts" })).toBe("src/a.ts\nsrc/nested/b.ts");
    expect(await run(tool, { pattern: "*.ts", path: "src/nested" })).toBe("src/nested/b.ts");
    expect(await run(tool, { pattern: "**/*.js" })).toBe("[no matches]");
  });
});

describe("shell", () => {
  it("runs in the root and reports exit code with stdout and stderr", async () => {
    const tool = makeShellTool(root);
    expect(await run(tool, { command: "cat README.md" })).toBe("# hello\n[exit code 0]");
    expect(await run(tool, { command: "echo oops >&2; exit 3" })).toBe(
      "[stderr]\noops\n[exit code 3]",
    );
  });

  it("kills the command at timeoutMs", async () => {
    const tool = makeShellTool(root);
    const output = await run(tool, { command: "sleep 5; echo late", timeoutMs: 100 });
    expect(output).toContain("[command timed out and was killed]");
    expect(output).not.toContain("late");
  });

  it("kills the command when the signal aborts", async () => {
    const tool = makeShellTool(root);
    const controller = new AbortController();
    const pending = run(tool, { command: "sleep 5; echo late" }, controller.signal);
    controller.abort();
    const output = await pending;
    expect(output).toContain("[command was cancelled]");
    expect(output).not.toContain("late");
  });
});
