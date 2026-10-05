import { FxSettings, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  applyFxModelSelection,
  FX_DRIVER_KIND,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  makeFxAcpRuntime,
} from "../../provider/acp/FxAcpSupport.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

const DEFAULT_FX_SETTINGS = Schema.decodeSync(FxSettings)({});

/**
 * The base ACP capabilities plus what fx advertises at initialize. Runtime-mode switching stays
 * false on purpose: the orchestrator then detaches the session on a mode change, and the next
 * turn reloads it and applies the new fx mode. Active steering stays false until a follow-up
 * adds a real steerTurn.
 */
export const FxProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  threads: { ...AcpProviderCapabilitiesV2.threads, canReadThreadSnapshot: true },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
  checkpointing: { ...AcpProviderCapabilitiesV2.checkpointing, providerCanReadConversationSnapshot: true },
} satisfies OrchestrationV2ProviderCapabilities;

export interface FxAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: FxSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  /** Reads the default model from this instance's latest probe. FxDriver owns the snapshot, so it supplies this. */
  readonly currentFxDefaultModel: Effect.Effect<string | undefined>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** Test seam: replay runtime from AcpAdapterV2.testkit.ts. */
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

export function makeFxAcpAdapterFlavor(options: FxAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: FX_DRIVER_KIND,
    runtimeHarness: "fx",
    capabilities: FxProviderCapabilitiesV2,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy: _runtimePolicy, ...input }: AcpAdapterV2RuntimeInput) =>
        makeFxAcpRuntime({
          ...input,
          fxSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        })),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.flatMap(options.currentFxDefaultModel, (fxDefaultModel) =>
        applyFxModelSelection({ runtime, requestedModel: modelSelection.model, fxDefaultModel }),
      ),
    sessionModeForPolicy: fxSessionModeForPolicy,
    permissionDisposition: fxPermissionDisposition,
  };
}

export function makeFxAdapterV2(options: FxAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeFxAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
}

export type FxAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const FxAdapterV2Driver: ProviderAdapterDriver<FxSettings, FxAdapterV2DriverEnv> = {
  driverKind: FX_DRIVER_KIND,
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => DEFAULT_FX_SETTINGS,
  create: Effect.fn("FxAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<FxSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeFxAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        currentFxDefaultModel: Effect.succeed(undefined),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: FX_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: FX_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create fx ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
