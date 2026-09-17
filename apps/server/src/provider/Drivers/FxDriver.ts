/**
 * FxDriver - `ProviderDriver` for the libfx-backed `fx` provider.
 *
 * Each session runs in its own runner child process (see
 * `packages/fx-runner`). The instance's API key comes from the `FX_API_KEY`
 * environment variable on the provider instance, which is the one place
 * secrets are stored redacted; the config blob only carries the model.
 */
import {
  FX_API_KEY_ENV,
  FxSettings,
  type ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { listFxModels } from "@t3tools/fx-runner/models";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { FX_DRIVER_KIND, makeFxAdapter } from "../Layers/FxAdapter.ts";
import { makeFxRunnerLauncher } from "../Layers/FxRunnerLink.ts";
import {
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  type FxModelCatalog,
  FxModelCatalogError,
  type FxProbeConfig,
} from "../Layers/FxProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: FX_DRIVER_KIND,
  packageName: null,
});

export type FxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ProviderEventLoggers
  | ServerSettingsService;

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

/** Text generation is not wired for fx yet; every call fails with a clear reason. */
const unsupportedTextGeneration: TextGeneration.TextGeneration["Service"] = {
  generateCommitMessage: () => textGenerationUnsupported("generateCommitMessage"),
  generatePrContent: () => textGenerationUnsupported("generatePrContent"),
  generateBranchName: () => textGenerationUnsupported("generateBranchName"),
  generateThreadTitle: () => textGenerationUnsupported("generateThreadTitle"),
};

function textGenerationUnsupported(operation: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail: "The fx provider does not support text generation.",
    }),
  );
}

const stampIdentity =
  (input: {
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: FX_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

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
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: FX_DRIVER_KIND,
        instanceId,
      });
      const stamp = stampIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const probeConfig: FxProbeConfig = {
        enabled: enabled && config.enabled,
        apiKey: nonEmpty(processEnv[FX_API_KEY_ENV]),
        model: nonEmpty(config.model),
      };

      const launcher = yield* makeFxRunnerLauncher({ environment: processEnv });
      const adapter = yield* makeFxAdapter(
        { instanceId, apiKey: probeConfig.apiKey, model: probeConfig.model },
        {
          launcher,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );

      const listModels: FxModelCatalog = (apiKey) =>
        Effect.tryPromise({
          try: () => listFxModels({ apiKey }),
          catch: (cause) =>
            new FxModelCatalogError({
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
      const checkProvider = checkFxProviderStatus(probeConfig, listModels).pipe(Effect.map(stamp));

      const snapshotSettings = makeProviderSnapshotSettingsSource(probeConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FxProbeConfig>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialFxProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider,
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
        adapter,
        textGeneration: unsupportedTextGeneration,
      } satisfies ProviderInstance;
    }),
};
