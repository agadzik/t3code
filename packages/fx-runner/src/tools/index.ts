import { makeEditFileTool, makeListDirTool, makeReadFileTool, makeWriteFileTool } from "./files.ts";
import { makeGlobTool, makeGrepTool } from "./search.ts";
import { makeShellTool } from "./shell.ts";
import type { HostTool } from "./types.ts";

export type { HostTool } from "./types.ts";

/** The complete coding tool set the runner hands to its fx agent. */
export function makeCodingTools(rootDir: string): ReadonlyArray<HostTool> {
  return [
    makeShellTool(rootDir),
    makeReadFileTool(rootDir),
    makeWriteFileTool(rootDir),
    makeEditFileTool(rootDir),
    makeListDirTool(rootDir),
    makeGrepTool(rootDir),
    makeGlobTool(rootDir),
  ];
}
