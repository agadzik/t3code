// @effect-diagnostics nodeBuiltinImport:off - the runner is a plain Node process that runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { compareCodePoints, resolveWithinRoot, toRootRelative } from "./paths.ts";
import type { HostTool } from "./types.ts";

const GrepInput = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  include: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  caseInsensitive: Schema.optional(Schema.Boolean),
  maxResults: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
const GlobInput = Schema.Struct({
  pattern: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  maxResults: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
const decodeGrepInput = Schema.decodeUnknownSync(GrepInput);
const decodeGlobInput = Schema.decodeUnknownSync(GlobInput);

const SEARCH_DEFAULT_MAX_RESULTS = 200;
const GREP_MAX_FILE_BYTES = 2_000_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

const excludeSkipped = (entry: string | { readonly name: string }) =>
  SKIPPED_DIRECTORIES.has(typeof entry === "string" ? NodePath.basename(entry) : entry.name);

async function globPaths(input: {
  readonly rootDir: string;
  readonly cwd: string;
  readonly pattern: string;
  readonly limit: number;
}): Promise<{ readonly paths: string[]; readonly truncated: boolean }> {
  const paths: string[] = [];
  for await (const match of NodeFSP.glob(input.pattern, {
    cwd: input.cwd,
    exclude: excludeSkipped,
  })) {
    if (paths.length >= input.limit) return { paths, truncated: true };
    paths.push(toRootRelative(input.rootDir, NodePath.join(input.cwd, match)));
  }
  paths.sort(compareCodePoints);
  return { paths, truncated: false };
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_000);
  return sample.includes(0);
}

export function makeGrepTool(rootDir: string): HostTool {
  return {
    name: "grep",
    description:
      "Search workspace text files for a literal substring (not a regex). Returns path:line:text matches. Skips .git and node_modules. Use include to narrow by glob, such as **/*.ts.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal text to find." },
        path: { type: "string", description: "Directory to search, relative to the root." },
        include: { type: "string", description: "Glob for candidate files. Defaults to **/*." },
        caseInsensitive: { type: "boolean" },
        maxResults: { type: "integer", description: "Stop after this many matching lines." },
      },
      required: ["pattern"],
    },
    async execute(rawInput, { signal }) {
      const input = decodeGrepInput(rawInput);
      const cwd = resolveWithinRoot(rootDir, input.path ?? ".");
      const limit = input.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS;
      const needle = input.caseInsensitive ? input.pattern.toLowerCase() : input.pattern;
      const { paths } = await globPaths({
        rootDir,
        cwd,
        pattern: input.include ?? "**/*",
        limit: Number.MAX_SAFE_INTEGER,
      });
      const lines: string[] = [];
      for (const relativePath of paths) {
        if (signal.aborted) break;
        const absolute = NodePath.join(rootDir, relativePath);
        const stat = await NodeFSP.stat(absolute).catch(() => null);
        if (!stat?.isFile() || stat.size > GREP_MAX_FILE_BYTES) continue;
        const buffer = await NodeFSP.readFile(absolute);
        if (isProbablyBinary(buffer)) continue;
        const fileLines = buffer.toString("utf8").split("\n");
        for (let index = 0; index < fileLines.length; index += 1) {
          const line = fileLines[index]!;
          const haystack = input.caseInsensitive ? line.toLowerCase() : line;
          if (!haystack.includes(needle)) continue;
          lines.push(`${relativePath}:${index + 1}:${line}`);
          if (lines.length >= limit) {
            return `${lines.join("\n")}\n[stopped at ${limit} matches]`;
          }
        }
      }
      return lines.length === 0 ? "[no matches]" : lines.join("\n");
    },
  };
}

export function makeGlobTool(rootDir: string): HostTool {
  return {
    name: "glob",
    description:
      "Find workspace files whose path matches a glob pattern, such as src/**/*.ts. Skips .git and node_modules.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern." },
        path: { type: "string", description: "Directory to search, relative to the root." },
        maxResults: { type: "integer", description: "Stop after this many paths." },
      },
      required: ["pattern"],
    },
    async execute(rawInput) {
      const input = decodeGlobInput(rawInput);
      const cwd = resolveWithinRoot(rootDir, input.path ?? ".");
      const limit = input.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS;
      const { paths, truncated } = await globPaths({ rootDir, cwd, pattern: input.pattern, limit });
      if (paths.length === 0) return "[no matches]";
      return truncated ? `${paths.join("\n")}\n[stopped at ${limit} paths]` : paths.join("\n");
    },
  };
}
