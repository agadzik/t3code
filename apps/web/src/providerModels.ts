import {
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, resolveSelectableModel } from "@t3tools/shared/model";

import { getDriverOption } from "./components/settings/providerDriverMeta";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return getDriverOption(provider)?.label ?? provider;
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id. Zero providers is valid.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind | undefined {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
  planModeEnabled = true,
): ModelCapabilities {
  const slug = resolveSelectableModel(provider, model, models);
  const selectedModel = models.find((candidate) => candidate.slug === slug);
  const caps = selectedModel?.capabilities ?? EMPTY_CAPABILITIES;
  if (planModeEnabled) {
    return caps;
  }
  return withoutPlanAgentOption(caps);
}

// The "plan" agent option is only reachable while legacy plan mode is on.
// With it off, drop the option so it cannot be selected or dispatched, and
// drop the descriptor entirely when nothing remains selectable. currentValue
// is re-resolved against the surviving options so a stale or defaulted "plan"
// value cannot leak back into dispatch.
function withoutPlanAgentOption(caps: ModelCapabilities): ModelCapabilities {
  return {
    ...caps,
    optionDescriptors: (caps.optionDescriptors ?? []).flatMap((descriptor) => {
      if (descriptor.type !== "select" || descriptor.id !== "agent") {
        return [descriptor];
      }
      const options = descriptor.options.filter((option) => option.id !== "plan");
      if (options.length === 0) {
        return [];
      }
      const currentValue =
        descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
          ? descriptor.currentValue
          : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
      return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
    }),
  };
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL
  );
}
