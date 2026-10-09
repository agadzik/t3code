import { FxSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeUnsupportedFxTextGeneration } from "./textGeneration.ts";
import { type FxAdapterV2DriverEnv, makeFxAdapterV2 } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  enrichFxSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { discoverFxSkills } from "./skills.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { FX_DRIVER_KIND } from "./acpSupport.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const decodeFxSettings = Schema.decodeSync(FxSettings);

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
  | FxAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

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
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
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
      const orchestrationAdapter = yield* makeFxAdapterV2({
        instanceId,
        settings: effectiveConfig,
        environment: mergeProviderInstanceEnvironment(environment, hostEnvironment),
        selfInvocation,
        currentFxDefaultModel: Ref.get(currentFxDefaultModelRef),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: FX_DRIVER_KIND,
            threadId,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FX_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the fx orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = makeUnsupportedFxTextGeneration();

      const provideSkillDiscovery = <A, E, R>(
        effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
      ) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

      const checkProvider = checkFxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.tap((probe) => Ref.set(currentFxDefaultModelRef, probe.defaultModel)),
        Effect.bindTo("probe"),
        Effect.bind("skills", () =>
          effectiveConfig.enabled
            ? provideSkillDiscovery(discoverFxSkills({ environment: processEnv }))
            : Effect.succeed([]),
        ),
        Effect.map(({ probe, skills }) => stampIdentity({ ...probe.draft, skills })),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
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
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FX_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the fx provider snapshot.",
              cause,
            }),
        ),
      );

      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              provideSkillDiscovery(
                discoverFxSkills({ cwd: workspaceCwd, environment: processEnv }),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

      return {
        instanceId,
        driverKind: FX_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
