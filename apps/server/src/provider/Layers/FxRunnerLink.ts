/**
 * FxRunnerLink - one live connection to an fx runner process.
 *
 * The launcher spawns `node <fx-runner bin>` with a fresh bearer token, waits
 * for its `listening` line on stdout, and opens the WebSocket. Everything the
 * adapter needs from a runner goes through the returned link, so tests swap
 * in an in-memory link and never spawn anything.
 */
import type { ThreadId } from "@t3tools/contracts";
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

export interface FxRunnerLink {
  readonly send: (frame: HostFrame) => Effect.Effect<void, ProviderAdapterRequestError>;
  /** Frames from the runner. Ends when the connection or the process goes away. */
  readonly frames: Stream.Stream<RunnerFrame>;
  readonly close: Effect.Effect<void>;
}

export interface FxRunnerLaunchInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
}

export interface FxRunnerLauncher {
  readonly launch: (
    input: FxRunnerLaunchInput,
  ) => Effect.Effect<FxRunnerLink, ProviderAdapterProcessError, Scope.Scope>;
}

export const makeFxRunnerLauncher = Effect.fn("makeFxRunnerLauncher")(function* (options: {
  readonly environment: NodeJS.ProcessEnv;
}) {
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
          .pipe(Effect.mapError((cause) => processError("Failed to spawn the fx runner.", cause))),
        (child) => child.kill().pipe(Effect.ignore),
      );

      const listening = yield* Deferred.make<number, ProviderAdapterProcessError>();
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
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
      yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* handle.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Deferred.fail(listening, processError(`fx runner exited with code ${exitCode}.`)),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );

      const port = yield* Deferred.await(listening).pipe(
        Effect.timeoutOption(LISTEN_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(processError("fx runner did not start listening in time.")),
            onSome: Effect.succeed,
          }),
        ),
      );

      const frames = yield* Queue.unbounded<RunnerFrame, Cause.Done>();
      const socket = yield* Effect.callback<WebSocket, ProviderAdapterProcessError>((resume) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { authorization: `Bearer ${token}` },
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
        send,
        frames: Stream.fromQueue(frames),
        close: Effect.sync(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "session stopped");
        }),
      } satisfies FxRunnerLink;
    },
  );

  return { launch } satisfies FxRunnerLauncher;
});
