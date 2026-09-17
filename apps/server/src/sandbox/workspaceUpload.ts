/**
 * Getting a thread's workspace into a sandbox: `git bundle` the checkout on
 * the host, upload the single file, `git clone` it inside. Only committed
 * history travels; uncommitted edits stay on the host.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SandboxApiError, SandboxCommandFailedError } from "./Errors.ts";
import type {
  SandboxCommandResult,
  SandboxHandle,
  SandboxRunCommandParams,
} from "./SandboxClient.ts";

/** Default working directory of a Vercel sandbox session. */
const SANDBOX_HOME = "/vercel/sandbox";
const SANDBOX_BUNDLE_PATH = `${SANDBOX_HOME}/.t3/workspace.bundle`;

/** Where the clone lands: the host folder name under the sandbox home, so paths read naturally in tool output. */
export const sandboxWorkspaceDir = (hostCwd: string): string => {
  const base =
    hostCwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${SANDBOX_HOME}/${safe === "" || safe === "." || safe === ".." ? "workspace" : safe}`;
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface WorkspaceBundlerShape {
  /** Bundle HEAD (and the checked-out branch, so the clone lands on it) into bytes. */
  readonly bundle: (cwd: string) => Effect.Effect<Uint8Array, SandboxApiError>;
}

/** A service so tests substitute canned bytes for a real `git bundle` run. */
export class WorkspaceBundler extends Context.Service<WorkspaceBundler, WorkspaceBundlerShape>()(
  "t3/sandbox/workspaceUpload/WorkspaceBundler",
) {}

const makeWorkspaceBundler = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitError = (detail: string, cause?: unknown) =>
    new SandboxApiError({
      operation: "git bundle",
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  const bundle: WorkspaceBundlerShape["bundle"] = Effect.fn("WorkspaceBundler.bundle")(function* (
    cwd: string,
  ) {
    const branch = yield* spawner
      .string(ChildProcess.make("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }))
      .pipe(
        Effect.map((text) => text.trim()),
        Effect.mapError((cause) => gitError(`Could not read the current branch in ${cwd}.`, cause)),
      );
    const refs = branch === "HEAD" || branch === "" ? ["HEAD"] : ["HEAD", branch];

    const tempDir = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-sandbox-bundle-" })
      .pipe(Effect.mapError((cause) => gitError("Could not create a temp directory.", cause)));
    const bundlePath = path.join(tempDir, "workspace.bundle");
    yield* spawner
      .string(ChildProcess.make("git", ["bundle", "create", bundlePath, ...refs], { cwd }))
      .pipe(
        Effect.mapError((cause) =>
          gitError(`git bundle failed in ${cwd}: ${errorText(cause)}`, cause),
        ),
      );
    yield* Effect.annotateCurrentSpan({ "sandbox.bundle.refs": refs.join(",") });
    return yield* fs
      .readFile(bundlePath)
      .pipe(Effect.mapError((cause) => gitError("Could not read the git bundle.", cause)));
  }, Effect.scoped);
  return WorkspaceBundler.of({ bundle });
});

export const workspaceBundlerLayer = Layer.effect(WorkspaceBundler, makeWorkspaceBundler);

const requireExitZero = (
  command: SandboxRunCommandParams,
  result: SandboxCommandResult,
): Effect.Effect<SandboxCommandResult, SandboxCommandFailedError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new SandboxCommandFailedError({
          command: [command.cmd, ...(command.args ?? [])].join(" "),
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
      );

/** Run a blocking command in the sandbox and fail on a non-zero exit. */
export const runChecked = (handle: SandboxHandle, command: SandboxRunCommandParams) =>
  handle.run(command).pipe(Effect.flatMap((result) => requireExitZero(command, result)));

/**
 * Upload a bundle and sync the workspace from it. Fresh sandboxes clone;
 * sandboxes booted from a project snapshot already have the checkout (git
 * refuses to clone into a nonempty directory), so they fetch the bundle and
 * hard-reset to the host's current committed state. Untracked files the
 * snapshot carried (installed dependencies) survive the reset.
 * Returns the workspace's absolute path inside the sandbox.
 */
export const uploadWorkspace = Effect.fn("uploadWorkspace")(function* (input: {
  readonly handle: SandboxHandle;
  readonly hostCwd: string;
  readonly bundle: Uint8Array;
}) {
  const workspaceDir = sandboxWorkspaceDir(input.hostCwd);
  yield* input.handle.writeFiles([{ path: SANDBOX_BUNDLE_PATH, content: input.bundle }]);
  const existing = yield* input.handle.run({
    cmd: "test",
    args: ["-d", `${workspaceDir}/.git`],
  });
  if (existing.exitCode === 0) {
    yield* runChecked(input.handle, {
      cmd: "git",
      args: ["-C", workspaceDir, "fetch", "--quiet", SANDBOX_BUNDLE_PATH, "HEAD"],
    });
    yield* runChecked(input.handle, {
      cmd: "git",
      args: ["-C", workspaceDir, "reset", "--hard", "--quiet", "FETCH_HEAD"],
    });
  } else {
    yield* runChecked(input.handle, {
      cmd: "git",
      args: ["clone", "--quiet", SANDBOX_BUNDLE_PATH, workspaceDir],
    });
  }
  yield* runChecked(input.handle, { cmd: "rm", args: ["-f", SANDBOX_BUNDLE_PATH] });
  return workspaceDir;
});
