/**
 * FxRunnerLink - one live connection to an fx runner process.
 *
 * A launcher brings a runner up somewhere, waits for its `listening`
 * announcement, and opens the WebSocket. Everything the adapter needs from a
 * runner goes through the returned link, so tests swap in an in-memory link
 * and never spawn anything. Two launchers exist: the local one spawns
 * `node <fx-runner bin>` as a child process; the sandbox one
 * (`sandbox/SandboxRunnerBackend.ts`) boots a Vercel Sandbox. The link's
 * `placement` tells the adapter which happened and what the runner's view of
 * the workspace is.
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { FX_RUNNER_ENTRYPOINT } from "@t3tools/fx-runner/entrypoint";
import {
  decodeRunnerFrame,
  decodeRunnerListening,
  encodeHostFrame,
  FX_RUNNER_TOKEN_ENV,
  type HostFrame,
  type RunnerFrame,
} from "@t3tools/fx-runner/protocol";
import type * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../Errors.ts";

const PROVIDER = "fx";
const LISTEN_TIMEOUT = Duration.seconds(20);

/**
 * Where the runner runs and how the adapter must address it in `init`.
 * `rootDir` is the workspace path as the runner sees it. A sandbox runner
 * never holds the real gateway key: egress injects it, so `apiKey` is the
 * placeholder the adapter must send instead of the instance key.
 */
export type FxRunnerPlacement =
  | { readonly kind: "local"; readonly rootDir: string }
  | {
      readonly kind: "sandbox";
      readonly rootDir: string;
      readonly sandboxName: string;
      readonly apiKey: string;
    };

export interface FxRunnerLink {
  readonly placement: FxRunnerPlacement;
  readonly send: (frame: HostFrame) => Effect.Effect<void, ProviderAdapterRequestError>;
  /** Frames from the runner. Ends when the connection or the process goes away. */
  readonly frames: Stream.Stream<RunnerFrame>;
  readonly close: Effect.Effect<void>;
}

export interface FxRunnerLaunchInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly projectId?: ProjectId | undefined;
}

export interface FxRunnerLauncher {
  readonly launch: (
    input: FxRunnerLaunchInput,
  ) => Effect.Effect<FxRunnerLink, ProviderAdapterProcessError, Scope.Scope>;
}

/**
 * Open the bearer-authenticated WebSocket to a listening runner and wrap it
 * as a link. Shared by every launcher; only the URL differs.
 */
export const connectRunnerSocket = Effect.fn("connectRunnerSocket")(function* (input: {
  readonly url: string;
  readonly token: string;
  readonly threadId: ThreadId;
  readonly placement: FxRunnerPlacement;
}) {
  const processError = (detail: string) =>
    new ProviderAdapterProcessError({ provider: PROVIDER, threadId: input.threadId, detail });
  const frames = yield* Queue.unbounded<RunnerFrame, Cause.Done>();
  const socket = yield* Effect.callback<WebSocket, ProviderAdapterProcessError>((resume) => {
    const ws = new WebSocket(input.url, {
      headers: { authorization: `Bearer ${input.token}` },
    });
    ws.addEventListener("open", () => resume(Effect.succeed(ws)), { once: true });
    ws.addEventListener(
      "error",
      () => resume(Effect.fail(processError("Failed to connect to the fx runner socket."))),
      { once: true },
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      Queue.endUnsafe(frames);
    }),
  );
  socket.addEventListener("close", () => {
    Queue.endUnsafe(frames);
  });
  socket.addEventListener("message", (message) => {
    try {
      Queue.offerUnsafe(frames, decodeRunnerFrame(String(message.data)));
    } catch (error) {
      Queue.offerUnsafe(frames, {
        type: "error",
        message: `Malformed runner frame: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      });
    }
  });

  const send: FxRunnerLink["send"] = (frame) =>
    Effect.try({
      try: () => {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("runner socket is not open");
        }
        socket.send(encodeHostFrame(frame));
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: `runner/${frame.type}`,
          detail: "Failed to send a frame to the fx runner.",
          cause,
        }),
    });

  return {
    placement: input.placement,
    send,
    frames: Stream.fromQueue(frames),
    close: Effect.sync(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "session stopped");
    }),
  } satisfies FxRunnerLink;
});

/**
 * Wait for the runner's `listening` line. Callers feed it every line the
 * runner prints (stdout locally, the command log in a sandbox) and race it
 * against process exit.
 */
export const awaitRunnerListening = (input: {
  readonly threadId: ThreadId;
  readonly lines: Stream.Stream<string, unknown>;
  readonly exit: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const processError = (detail: string) =>
      new ProviderAdapterProcessError({ provider: PROVIDER, threadId: input.threadId, detail });
    const listening = yield* Deferred.make<number, ProviderAdapterProcessError>();
    yield* input.lines.pipe(
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if (line.trim().length === 0) return;
          try {
            Deferred.doneUnsafe(listening, Effect.succeed(decodeRunnerListening(line).port));
          } catch {
            // The runner only writes protocol lines to stdout; anything else is noise.
          }
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* input.exit.pipe(
      Effect.flatMap((detail) => Deferred.fail(listening, processError(detail))),
      Effect.ignore,
      Effect.forkScoped,
    );
    return yield* Deferred.await(listening).pipe(
      Effect.timeoutOption(LISTEN_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(processError("fx runner did not start listening in time.")),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

export const makeLocalFxRunnerLauncher = Effect.fn("makeLocalFxRunnerLauncher")(
  function* (options: { readonly environment: NodeJS.ProcessEnv }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;

    const launch: FxRunnerLauncher["launch"] = Effect.fn("FxRunnerLauncher.launch")(
      function* (input) {
        const processError = (detail: string, cause?: unknown) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail,
            ...(cause !== undefined ? { cause } : {}),
          });
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => processError("Failed to generate a runner token.", cause)),
        );
        const command = ChildProcess.make(process.execPath, [FX_RUNNER_ENTRYPOINT], {
          cwd: input.cwd,
          env: { ...options.environment, [FX_RUNNER_TOKEN_ENV]: token },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        });
        const handle = yield* Effect.acquireRelease(
          spawner
            .spawn(command)
            .pipe(
              Effect.mapError((cause) => processError("Failed to spawn the fx runner.", cause)),
            ),
          (child) => child.kill().pipe(Effect.ignore),
        );
        yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

        const port = yield* awaitRunnerListening({
          threadId: input.threadId,
          lines: handle.stdout.pipe(Stream.decodeText(), Stream.splitLines),
          exit: handle.exitCode.pipe(
            Effect.map((exitCode) => `fx runner exited with code ${exitCode}.`),
            Effect.orElseSucceed(() => "fx runner exited."),
          ),
        });

        return yield* connectRunnerSocket({
          url: `ws://127.0.0.1:${port}`,
          token,
          threadId: input.threadId,
          placement: { kind: "local", rootDir: input.cwd },
        });
      },
    );

    return { launch } satisfies FxRunnerLauncher;
  },
);

/**
 * Backend selection. The sandbox launcher is consulted per launch so a
 * settings flip takes effect on the next session without a driver rebuild.
 * Without a sandbox option (dev, tests) this is the local launcher unchanged.
 */
export const makeFxRunnerLauncher = Effect.fn("makeFxRunnerLauncher")(function* (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly sandbox?:
    | { readonly launcher: FxRunnerLauncher; readonly enabled: Effect.Effect<boolean> }
    | undefined;
}) {
  const local = yield* makeLocalFxRunnerLauncher({ environment: options.environment });
  const sandbox = options.sandbox;
  if (sandbox === undefined) return local;
  return {
    launch: (input) =>
      Effect.flatMap(sandbox.enabled, (enabled) =>
        enabled ? sandbox.launcher.launch(input) : local.launch(input),
      ),
  } satisfies FxRunnerLauncher;
});
