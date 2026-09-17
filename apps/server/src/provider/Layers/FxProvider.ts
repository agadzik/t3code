/**
 * FxProvider - status snapshot for an fx instance.
 *
 * There is no CLI to probe: the instance is "installed" when the runner
 * package resolves, and "authenticated" when the configured key can list
 * the gateway model catalog. That catalog is the model list users pick from.
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

export class FxModelCatalogError extends Schema.TaggedError<FxModelCatalogError>()(
  "FxModelCatalogError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not reach the AI Gateway model catalog: ${this.detail}`;
  }
}

export type FxModelCatalog = (
  apiKey: string,
) => Effect.Effect<ReadonlyArray<string>, FxModelCatalogError>;

export const FX_PRESENTATION = {
  displayName: "fx",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

export interface FxProbeConfig {
  readonly enabled: boolean;
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
}

export function fxModelsFromCatalog(
  modelIds: ReadonlyArray<string>,
  defaultModel: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const ids = new Set(modelIds);
  if (defaultModel !== undefined && defaultModel.length > 0) ids.add(defaultModel);
  return Array.from(ids)
    .sort()
    .map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(slug === defaultModel ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    }));
}

export const buildInitialFxProviderSnapshot = Effect.fn("buildInitialFxProviderSnapshot")(
  function* (config: FxProbeConfig): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = fxModelsFromCatalog([], config.model);
    if (!config.enabled) {
      return buildServerProvider({
        presentation: FX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "fx is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking fx gateway access...",
      },
    });
  },
);

export const checkFxProviderStatus = Effect.fn("checkFxProviderStatus")(function* (
  config: FxProbeConfig,
  listModels: FxModelCatalog,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  if (!config.enabled) {
    return yield* buildInitialFxProviderSnapshot(config);
  }
  if (config.apiKey === undefined) {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fxModelsFromCatalog([], config.model),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unauthenticated", type: "api-key" },
        message:
          "No API key configured. Add an FX_API_KEY environment variable (marked sensitive) to this provider instance.",
      },
    });
  }
  const catalog = yield* listModels(config.apiKey).pipe(Effect.result);
  if (Result.isFailure(catalog)) {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fxModelsFromCatalog([], config.model),
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated", type: "api-key" },
        message: catalog.failure.message,
      },
    });
  }
  return buildServerProvider({
    presentation: FX_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fxModelsFromCatalog(catalog.success, config.model),
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", type: "api-key" },
    },
  });
});
