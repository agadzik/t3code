// @effect-diagnostics nodeBuiltinImport:off - the runner is a plain Node process that runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { compareCodePoints, resolveWithinRoot } from "./paths.ts";
import { type HostTool, ToolInputError } from "./types.ts";

const PathField = Schema.String.check(Schema.isMinLength(1));

const ReadFileInput = Schema.Struct({
  path: PathField,
  startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  lineCount: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
const WriteFileInput = Schema.Struct({ path: PathField, content: Schema.String });
const EditFileInput = Schema.Struct({
  path: PathField,
  oldString: Schema.String.check(Schema.isMinLength(1)),
  newString: Schema.String,
});
const ListDirInput = Schema.Struct({ path: Schema.optional(PathField) });

const decodeReadFileInput = Schema.decodeUnknownSync(ReadFileInput);
const decodeWriteFileInput = Schema.decodeUnknownSync(WriteFileInput);
const decodeEditFileInput = Schema.decodeUnknownSync(EditFileInput);
const decodeListDirInput = Schema.decodeUnknownSync(ListDirInput);

const READ_FILE_MAX_BYTES = 1_000_000;
const READ_FILE_DEFAULT_LINE_COUNT = 2_000;

export function makeReadFileTool(rootDir: string): HostTool {
  return {
    name: "readFile",
    description:
      "Read a UTF-8 text file inside the workspace. Output is line-numbered. Use startLine and lineCount to page through large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        startLine: { type: "integer", description: "1-based first line. Defaults to 1." },
        lineCount: { type: "integer", description: "Lines to return. Defaults to 2000." },
      },
      required: ["path"],
    },
    async execute(rawInput) {
      const input = decodeReadFileInput(rawInput);
      const absolute = resolveWithinRoot(rootDir, input.path);
      const stat = await NodeFSP.stat(absolute);
      if (!stat.isFile()) throw new ToolInputError(`Not a file: ${input.path}`);
      if (stat.size > READ_FILE_MAX_BYTES) {
        throw new ToolInputError(
          `File is ${stat.size} bytes; the limit is ${READ_FILE_MAX_BYTES}. Use shell tools to inspect it.`,
        );
      }
      const lines = (await NodeFSP.readFile(absolute, "utf8")).split("\n");
      const start = input.startLine ?? 1;
      const count = input.lineCount ?? READ_FILE_DEFAULT_LINE_COUNT;
      const slice = lines.slice(start - 1, start - 1 + count);
      const width = String(start + slice.length - 1).length;
      const body = slice
        .map((line, index) => `${String(start + index).padStart(width)}\t${line}`)
        .join("\n");
      const remaining = lines.length - (start - 1 + slice.length);
      return remaining > 0 ? `${body}\n[${remaining} more lines]` : body;
    },
  };
}

export function makeWriteFileTool(rootDir: string): HostTool {
  return {
    name: "writeFile",
    description:
      "Create or overwrite a UTF-8 text file inside the workspace with the complete contents. Parent directories are created.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Complete file contents." },
      },
      required: ["path", "content"],
    },
    async execute(rawInput) {
      const input = decodeWriteFileInput(rawInput);
      const absolute = resolveWithinRoot(rootDir, input.path);
      await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
      await NodeFSP.writeFile(absolute, input.content, "utf8");
      return `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${input.path}`;
    },
  };
}

export function makeEditFileTool(rootDir: string): HostTool {
  return {
    name: "editFile",
    description:
      "Replace one exact occurrence of oldString with newString in a workspace file. Fails when oldString is missing or matches more than once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        oldString: { type: "string", description: "Exact text to find. Must match once." },
        newString: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute(rawInput) {
      const input = decodeEditFileInput(rawInput);
      const absolute = resolveWithinRoot(rootDir, input.path);
      const current = await NodeFSP.readFile(absolute, "utf8");
      const first = current.indexOf(input.oldString);
      if (first === -1) throw new ToolInputError(`oldString not found in ${input.path}`);
      if (current.indexOf(input.oldString, first + input.oldString.length) !== -1) {
        throw new ToolInputError(`oldString matches more than once in ${input.path}`);
      }
      const next =
        current.slice(0, first) + input.newString + current.slice(first + input.oldString.length);
      await NodeFSP.writeFile(absolute, next, "utf8");
      return `Edited ${input.path}`;
    },
  };
}

export function makeListDirTool(rootDir: string): HostTool {
  return {
    name: "listDir",
    description:
      "List the entries of a workspace directory. Directories end with a slash. Defaults to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the workspace root." },
      },
    },
    async execute(rawInput) {
      const input = decodeListDirInput(rawInput ?? {});
      const absolute = resolveWithinRoot(rootDir, input.path ?? ".");
      const entries = await NodeFSP.readdir(absolute, { withFileTypes: true });
      const names = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort(compareCodePoints);
      return names.length === 0 ? "[empty directory]" : names.join("\n");
    },
  };
}
