/**
 * SandboxRunnerBackend - the `FxRunnerLauncher` that runs a runner inside a
 * Vercel Sandbox instead of a local child process.
 *
 * Per launch: boot a sandbox named after the thread from the project's
 * snapshot (or the base image), upload the workspace as a git bundle and
 * clone it, start the runner detached on a fixed port, wait for its
 * `listening` line in the command log, and connect over the sandbox's public
 * domain. The gateway key never enters the sandbox: the network policy
 * injects it at egress and the runner is told to use the placeholder key.
 * Closing the session scope stops the sandbox.
 */
import {
  type ProjectId,
  SANDBOX_INJECTED_API_KEY,
  SANDBOX_RUNNER_ENTRYPOINT,
  SANDBOX_RUNNER_PORT,
  sandboxNetworkPolicy,
  type ThreadId,
} from "@t3tools/contracts";
import {
  FX_RUNNER_HOST_ENV,
  FX_RUNNER_PORT_ENV,
  FX_RUNNER_TOKEN_ENV,
} from "@t3tools/fx-runner/protocol";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderAdapterProcessError } from "../provider/Errors.ts";
import {
  awaitRunnerListening,
  connectRunnerSocket,
  type FxRunnerLauncher,
} from "../provider/Layers/FxRunnerLink.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VercelAuthService } from "../vercel/VercelAuthService.ts";
import { type SandboxApiError, SandboxNotConfiguredError } from "./Errors.ts";
import { ProjectSandboxImages } from "./ProjectSandboxImages.ts";
import { SandboxClient, type SandboxListing, type SandboxSource } from "./SandboxClient.ts";
import { uploadWorkspace, WorkspaceBundler } from "./workspaceUpload.ts";

const PROVIDER = "fx";

/** Vercel Pro caps a session at 24 hours; the session ends with the sandbox, no auto-resume. */
export const THREAD_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const THREAD_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_SANDBOX_NAME_PREFIX = "t3-";
export const THREAD_SANDBOX_TAG = { key: "t3code", value: "thread" } as const;

/** Sandbox names are lowercase slugs; thread ids are already url-safe but not guaranteed lowercase. */
export const sandboxNameForThread = (threadId: ThreadId): string =>
  `${THREAD_SANDBOX_NAME_PREFIX}${threadId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

const ORPHAN_STATUSES: ReadonlySet<SandboxListing["status"]> = new Set(["pending", "running"]);

/** Thread sandboxes still running that no live session in this process owns. */
export const selectOrphanSandboxes = (
  listings: ReadonlyArray<SandboxListing>,
  liveNames: ReadonlySet<string>,
): ReadonlyArray<SandboxListing> =>
  listings.filter(
    (listing) =>
      listing.name.startsWith(THREAD_SANDBOX_NAME_PREFIX) &&
      listing.tags[THREAD_SANDBOX_TAG.key] === THREAD_SANDBOX_TAG.value &&
      ORPHAN_STATUSES.has(listing.status) &&
      !liveNames.has(listing.name),
  );

export interface SandboxRunnerBackendShape {
  readonly launcher: FxRunnerLauncher;
  /** Sandbox execution is switched on and has a team and project. Read per call. */
  readonly isEnabled: Effect.Effect<boolean>;
  /** Stop thread sandboxes left running by a server that died. Returns the names stopped. */
  readonly reapOrphans: Effect.Effect<ReadonlyArray<string>, SandboxApiError>;
}

export class SandboxRunnerBackend extends Context.Service<
  SandboxRunnerBackend,
  SandboxRunnerBackendShape
>()("t3/sandbox/SandboxRunnerBackend") {}

export interface SandboxRunnerBackendOptions {
  /** Test seam: the WebSocket connect, so tests assert the URL without a network. */
  readonly connect?: typeof connectRunnerSocket | undefined;
}

export const make = Effect.fn("SandboxRunnerBackend.make")(function* (
  options: SandboxRunnerBackendOptions = {},
) {
  const connect = options.connect ?? connectRunnerSocket;
  const client = yield* SandboxClient;
  const images = yield* ProjectSandboxImages;
  const settings = yield* ServerSettingsService;
  const vercelAuth = yield* VercelAuthService;
  const crypto = yield* Crypto.Crypto;
  const bundler = yield* WorkspaceBundler;
  const live = new Set<string>();

  const sandboxSettings = settings.getSettings.pipe(Effect.map((current) => current.vercelSandbox));

  const isEnabled = sandboxSettings.pipe(
    Effect.map((sandbox) => sandbox.enabled && sandbox.teamId !== "" && sandbox.projectId !== ""),
    Effect.orElseSucceed(() => false),
  );

  const resolveSource = Effect.fn("SandboxRunnerBackend.resolveSource")(function* (input: {
    readonly projectId: ProjectId | undefined;
    readonly cwd: string;
    readonly baseImage: string;
  }) {
    if (input.projectId === undefined) {
      return { kind: "image", image: input.baseImage } satisfies SandboxSource;
    }
    return yield* images.resolveSource({
      projectId: input.projectId,
      cwd: input.cwd,
      baseImage: input.baseImage,
    });
  });

  const launch: FxRunnerLauncher["launch"] = Effect.fn("SandboxRunnerBackend.launch")(
    function* (input) {
      const processError = (detail: string, cause?: unknown) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail,
          ...(cause !== undefined ? { cause } : {}),
        });
      const fromSandboxError = (error: { readonly message: string }) =>
        processError(error.message, error);

      const current = yield* sandboxSettings.pipe(
        Effect.mapError((cause) => processError("Could not read settings.", cause)),
      );
      const gatewayKey = yield* vercelAuth
        .getValidGatewayKey()
        .pipe(Effect.mapError((cause) => processError(cause.detail, cause)));
      if (Option.isNone(gatewayKey)) {
        return yield* fromSandboxError(
          new SandboxNotConfiguredError({
            detail:
              "Sandbox execution needs an AI Gateway key. Connect Vercel or paste a gateway key in Settings > Providers > Vercel.",
          }),
        );
      }
      const token = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => processError("Failed to generate a runner token.", cause)),
      );
      const name = sandboxNameForThread(input.threadId);
      const createParams = (source: SandboxSource) => ({
        name,
        source,
        timeoutMs: THREAD_SANDBOX_TIMEOUT_MS,
        ports: [SANDBOX_RUNNER_PORT],
        networkPolicy: sandboxNetworkPolicy(gatewayKey.value),
        env: {
          [FX_RUNNER_TOKEN_ENV]: token,
          [FX_RUNNER_PORT_ENV]: String(SANDBOX_RUNNER_PORT),
          [FX_RUNNER_HOST_ENV]: "0.0.0.0",
        },
        tags: {
          [THREAD_SANDBOX_TAG.key]: THREAD_SANDBOX_TAG.value,
          threadId: input.threadId,
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        },
        snapshotExpirationMs: THREAD_SNAPSHOT_EXPIRATION_MS,
        keepLastSnapshots: { count: 1 },
      });

      const source = yield* resolveSource({
        projectId: input.projectId,
        cwd: input.cwd,
        baseImage: current.image,
      }).pipe(Effect.mapError(fromSandboxError));
      // A persisted snapshot can expire or be deleted out from under us:
      // forget it, rebuild the project image once, and boot from the new one.
      const handle = yield* Effect.acquireRelease(
        client.create(createParams(source)).pipe(
          Effect.catchTag("SandboxSnapshotGoneError", (gone) =>
            input.projectId === undefined
              ? Effect.fail(gone)
              : images.invalidate(input.projectId).pipe(
                  Effect.andThen(
                    resolveSource({
                      projectId: input.projectId,
                      cwd: input.cwd,
                      baseImage: current.image,
                    }),
                  ),
                  Effect.flatMap((rebuilt) => client.create(createParams(rebuilt))),
                ),
          ),
          Effect.mapError(fromSandboxError),
          Effect.tap((created) => Effect.sync(() => live.add(created.name))),
        ),
        (created) =>
          created.stop.pipe(
            Effect.ignore,
            Effect.tap(() => Effect.sync(() => live.delete(created.name))),
          ),
      );

      const bundle = yield* bundler.bundle(input.cwd).pipe(Effect.mapError(fromSandboxError));
      const rootDir = yield* uploadWorkspace({ handle, hostCwd: input.cwd, bundle }).pipe(
        Effect.mapError(fromSandboxError),
      );

      const runner = yield* handle
        .runDetached({ cmd: "node", args: [SANDBOX_RUNNER_ENTRYPOINT], cwd: rootDir })
        .pipe(Effect.mapError(fromSandboxError));
      yield* awaitRunnerListening({
        threadId: input.threadId,
        lines: runner.logs.pipe(
          Stream.filter((log) => log.stream === "stdout"),
          Stream.map((log) => log.data),
          Stream.splitLines,
        ),
        exit: runner.wait.pipe(
          Effect.map((result) => `fx runner exited with code ${result.exitCode}.`),
          Effect.orElseSucceed(() => "fx runner exited."),
        ),
      });

      const domain = yield* handle
        .domain(SANDBOX_RUNNER_PORT)
        .pipe(Effect.mapError(fromSandboxError));
      return yield* connect({
        url: domain.replace(/^http/, "ws"),
        token,
        threadId: input.threadId,
        placement: {
          kind: "sandbox",
          rootDir,
          sandboxName: name,
          apiKey: SANDBOX_INJECTED_API_KEY,
        },
      });
    },
  );

  const reapOrphans: SandboxRunnerBackendShape["reapOrphans"] = Effect.gen(function* () {
    const listings = yield* client.list({
      namePrefix: THREAD_SANDBOX_NAME_PREFIX,
      tag: THREAD_SANDBOX_TAG,
    });
    const orphans = selectOrphanSandboxes(listings, live);
    const stopped: string[] = [];
    for (const orphan of orphans) {
      const handle = yield* client.get(orphan.name);
      if (Option.isNone(handle)) continue;
      yield* handle.value.stop;
      stopped.push(orphan.name);
      yield* Effect.logInfo("sandbox.reaper.stopped", { sandbox: orphan.name, tags: orphan.tags });
    }
    return stopped;
  });

  return SandboxRunnerBackend.of({ launcher: { launch }, isEnabled, reapOrphans });
});

export const makeLayer = (options: SandboxRunnerBackendOptions = {}) =>
  Layer.effect(SandboxRunnerBackend, make(options));

export const layer = makeLayer();
