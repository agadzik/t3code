// @effect-diagnostics nodeBuiltinImport:off - the runner is a plain Node process that runs outside the Effect runtime.
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";

import * as Schema from "effect/Schema";

import { type HostTool, ToolInputError } from "./types.ts";

const ShellInput = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
const decodeShellInput = Schema.decodeUnknownSync(ShellInput);

// oxlint-disable-next-line t3code/no-global-process-runtime -- The runner is a standalone process with no Effect runtime to inject.
const IS_WINDOWS = process.platform === "win32";

const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
const SHELL_MAX_TIMEOUT_MS = 600_000;
/** Per-stream byte cap. The tail is kept because failures print last. */
const SHELL_OUTPUT_CAP_BYTES = 200_000;

export interface ShellResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly truncated: boolean;
}

/** Keeps at most `cap` bytes of the most recent output. */
function makeTailBuffer(cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > cap && chunks.length > 0) {
        const head = chunks[0]!;
        const excess = size - cap;
        if (head.length <= excess) {
          chunks.shift();
          size -= head.length;
        } else {
          chunks[0] = head.subarray(excess);
          size -= excess;
        }
        truncated = true;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get truncated() {
      return truncated;
    },
  };
}

function runShell(input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so the timeout kill reaches grandchildren.
      detached: !IS_WINDOWS,
    });
    const stdout = makeTailBuffer(SHELL_OUTPUT_CAP_BYTES);
    const stderr = makeTailBuffer(SHELL_OUTPUT_CAP_BYTES);
    let timedOut = false;
    let aborted = false;

    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (IS_WINDOWS) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

function formatShellResult(result: ShellResult): string {
  const parts: string[] = [];
  if (result.stdout.length > 0) parts.push(result.stdout.trimEnd());
  if (result.stderr.length > 0) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push("[output truncated; only the tail is shown]");
  if (result.timedOut) parts.push("[command timed out and was killed]");
  else if (result.aborted) parts.push("[command was cancelled]");
  parts.push(
    result.exitCode === null
      ? `[terminated by signal ${result.signal ?? "unknown"}]`
      : `[exit code ${result.exitCode}]`,
  );
  return parts.join("\n");
}

export function makeShellTool(rootDir: string): HostTool {
  return {
    name: "shell",
    description:
      "Run a shell command in the workspace root and return its stdout, stderr, and exit code. Long output keeps only the tail. Commands are killed at timeoutMs (default 120000).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line passed to the system shell." },
        timeoutMs: { type: "integer", description: "Kill the command after this many ms." },
      },
      required: ["command"],
    },
    async execute(rawInput, { signal }) {
      const input = decodeShellInput(rawInput);
      const timeoutMs = Math.min(input.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS, SHELL_MAX_TIMEOUT_MS);
      if (signal.aborted) throw new ToolInputError("Command cancelled before it started.");
      const result = await runShell({ command: input.command, cwd: rootDir, timeoutMs, signal });
      return formatShellResult(result);
    },
  };
}
