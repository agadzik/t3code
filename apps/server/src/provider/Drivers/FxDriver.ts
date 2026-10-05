import { FxSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { makeFxAdapterV2 } from "../../orchestration-v2/Adapters/FxAdapterV2.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/UnsupportedTextGeneration.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { FX_DRIVER_KIND } from "../acp/FxAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  enrichFxSnapshot,
} from "../Layers/FxProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);

/** `fx upgrade` is fx's own updater. No npm package exists, so latestVersion stays null. */
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: FX_DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["upgrade"],
            updateLockKey: "fx",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: FX_DRIVER_KIND,
            packageName: null,
          }),
    ),
};

export type FxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const FxDriver: ProviderDriver<FxSettings, FxDriverEnv> = {
  driverKind: FX_DRIVER_KIND,
  metadata: {
    displayName: "fx",
    supportsMultipleInstances: true,
  },
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => decodeFxSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: FX_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (draft: ServerProviderDraft) => ({
        ...withInstanceIdentity({
          instanceId,
          driverKind: FX_DRIVER_KIND,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        })(draft),
        supportsTextGeneration: false,
      });
      const effectiveConfig = { ...config, enabled } satisfies FxSettings;
      const currentFxDefaultModelRef = yield* Ref.make<string | undefined>(undefined);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const orchestrationAdapter = makeFxAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: mergeProviderInstanceEnvironment(environment, hostEnvironment),
        childProcessSpawner: spawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        currentFxDefaultModel: Ref.get(currentFxDefaultModelRef),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: FX_DRIVER_KIND,
            threadId,
          }),
      });
      // Every fx acp session is saved under the user's fx home, and generation 1
      // has no session/delete, so one helper session per title would fill history.
      const textGeneration = makeUnsupportedTextGeneration(
        "fx does not provide application text generation yet.",
      );

      const checkProvider = checkFxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.tap((probe) => Ref.set(currentFxDefaultModelRef, probe.defaultModel)),
        Effect.map((probe) => stampIdentity(probe.draft)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FxSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialFxProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichFxSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FX_DRIVER_KIND,
              instanceId,
              detail: `Failed to build fx snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: FX_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
