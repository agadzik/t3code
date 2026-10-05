import { type FxSettings, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import {
  applyFxModelSelection,
  FX_DRIVER_KIND,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  makeFxAcpRuntime,
} from "../../provider/acp/FxAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

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
