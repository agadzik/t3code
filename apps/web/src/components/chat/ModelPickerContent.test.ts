import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  adjacentModelPickerProvider,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";

function entry(status: ServerProvider["status"], driver = "testDriver") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["error", "warning"] as const)(
    "keeps only the active unavailable row when the provider status is %s",
    (status) => {
      const providerEntry = entry(status);
      const activeInstanceId = providerEntry.instanceId;
      const activeModel = "missing-model";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId: ProviderInstanceId.make("testDriver_personal"),
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("resolveModelPickerSelectedModel", () => {
  it("returns the option whose slug matches the selected model", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("testDriver"),
        model: "fast",
        options: [
          { slug: "fast", name: "Fast" },
          { slug: "pro", name: "Pro" },
        ],
      })?.slug,
    ).toBe("fast");
  });

  it("returns undefined when no option matches", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("testDriver"),
        model: "missing",
        options: [{ slug: "fast", name: "Fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "model-pro", name: "Model Pro" };

  function withSetup(providerEntry: ReturnType<typeof entry>) {
    return {
      ...providerEntry,
      snapshot: {
        ...providerEntry.snapshot,
        setup: { canAuthenticate: true, canInstall: false },
      },
    };
  }

  it("offers setup before an account has models", () => {
    expect(shouldOfferModelPickerSetup(withSetup(entry("error")), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = withSetup(entry("ready"));
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(withSetup(entry("ready")), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(withSetup(entry("ready")), [availableModel])).toBe(false);
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(shouldOfferModelPickerSetup({ ...withSetup(entry("error")), enabled: false }, [])).toBe(
      false,
    );
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    expect(shouldOfferModelPickerSetup(withSetup(entry("error", "custom_driver")), [])).toBe(true);
  });
});

describe("adjacentModelPickerProvider", () => {
  const first = entry("ready", "alpha");
  const second = entry("ready", "beta");
  const unavailable = entry("error");
  const input = {
    entries: [first, unavailable, second],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("wraps through favorites and ready instances, skipping unavailable providers", () => {
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: first.instanceId, direction: 1 }),
    ).toBe(second.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: -1 }),
    ).toBe(second.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: second.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
  });

  it("keeps thread locks and the selected unavailable catalog", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        disabledInstanceIds: new Set([second.instanceId]),
        selectedInstanceId: first.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectableUnavailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: first.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
  });

  it("handles an empty catalog and a removed selection in either direction", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        entries: [],
        selectedInstanceId: first.instanceId,
        direction: -1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: -1,
      }),
    ).toBe(second.instanceId);
  });
});
