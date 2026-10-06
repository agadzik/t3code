import { type FxSettings, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import {
  applyFxEffortSelection,
  applyFxModelSelection,
  FX_DRIVER_KIND,
  FX_EFFORT_CONFIG_ID,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  makeFxAcpRuntime,
  withFxSessionModeAlwaysWritten,
} from "../../provider/acp/FxAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const FxProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: { ...AcpProviderCapabilitiesV2.threads, canReadThreadSnapshot: true },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
  checkpointing: { ...AcpProviderCapabilitiesV2.checkpointing, providerCanReadConversationSnapshot: true },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: false,
  },
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
  readonly currentFxDefaultModel: Effect.Effect<string | undefined>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

export function makeFxAcpAdapterFlavor(options: FxAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: FX_DRIVER_KIND,
    runtimeHarness: "fx",
    capabilities: FxProviderCapabilitiesV2,
    makeRuntime: (input: AcpAdapterV2RuntimeInput) =>
      (options.makeRuntime ??
        (({ runtimePolicy: _runtimePolicy, ...runtimeInput }: AcpAdapterV2RuntimeInput) =>
          makeFxAcpRuntime({
            ...runtimeInput,
            fxSettings: options.settings,
            environment: options.environment,
            childProcessSpawner: options.childProcessSpawner,
          })))(input).pipe(Effect.map(withFxSessionModeAlwaysWritten)),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        const fxDefaultModel = yield* options.currentFxDefaultModel;
        const applied = yield* applyFxModelSelection({
          runtime,
          requestedModel: modelSelection.model,
          fxDefaultModel,
        });
        yield* applyFxEffortSelection({
          runtime,
          requestedEffort: modelSelection.options?.find((option) => option.id === FX_EFFORT_CONFIG_ID)
            ?.value,
        });
        return applied;
      }),
    sessionModeForPolicy: fxSessionModeForPolicy,
    permissionDisposition: fxPermissionDisposition,
  };
}

export type FxAdapterV2 = ReturnType<typeof makeAcpAdapterV2> & {
  readonly currentFxDefaultModel: Effect.Effect<string | undefined>;
};

export function makeFxAdapterV2(options: FxAdapterV2Options): FxAdapterV2 {
  return {
    ...makeAcpAdapterV2({
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
    }),
    currentFxDefaultModel: options.currentFxDefaultModel,
  };
}
