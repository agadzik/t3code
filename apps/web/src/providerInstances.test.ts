import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderEntriesByEnvironment,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: "testDriver",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled instances in the rail and removes disabled instances", () => {
    const [enabledEntry, disabledEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "otherDriver",
        enabled: false,
      }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("testDriver")]: {
          driver: ProviderDriverKind.make("testDriver"),
          enabled: false,
        },
      },
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "claude_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
    });

    expect(entry?.enabled).toBe(false);
  });

  it.each(["constructor", "toString"])(
    "treats a removed custom instance named %s as disabled",
    (instanceId) => {
      const entries = deriveProviderInstanceEntries([
        provider({
          provider: ProviderDriverKind.make("otherDriver"),
          instanceId,
        }),
      ]);
      const [entry] = applyProviderInstanceSettings(entries, {
        providerInstances: {},
      });

      expect(entry?.enabled).toBe(false);
    },
  );

  it("uses settings for a configured custom instance named constructor", () => {
    const instanceId = ProviderInstanceId.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId,
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("otherDriver"),
          enabled: false,
        },
      },
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed default instance for a fork driver as disabled", () => {
    const driver = ProviderDriverKind.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: driver,
        instanceId: "constructor",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
    });

    expect(entry?.isDefault).toBe(true);
    expect(entry?.enabled).toBe(false);
  });

  it("treats a default instance without a settings overlay as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: "testDriver",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
    });

    expect(entry?.enabled).toBe(false);
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("testDriver"),
      instanceId: "testDriver_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("testDriver_personal");
    expect(entry?.driverKind).toBe("testDriver");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("deriveProviderEntriesByEnvironment", () => {
  it("keeps same-id default instances distinct per environment", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Local",
            accentColor: "#112233",
          }),
        ],
      ],
      [
        "remote",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Remote",
            accentColor: "#445566",
          }),
        ],
      ],
    ]);

    expect(byEnvironment.get("local")?.get("claude")?.displayName).toBe("Claude Local");
    expect(byEnvironment.get("local")?.get("claude")?.accentColor).toBe("#112233");
    expect(byEnvironment.get("remote")?.get("claude")?.displayName).toBe("Claude Remote");
    expect(byEnvironment.get("remote")?.get("claude")?.accentColor).toBe("#445566");
  });

  it("never falls back to another environment's instances", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" })],
      ],
      ["empty", []],
    ]);

    expect(byEnvironment.get("empty")?.get("codex")).toBeUndefined();
    // Every environment gets its own bucket, so an absent lookup is a real
    // "this environment has no such instance", not a missing key.
    expect(byEnvironment.get("empty")?.size).toBe(0);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("otherDriver_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" }),
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("testDriver");
    const fallback = ProviderInstanceId.make("otherDriver");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("testDriver");
    const ready = ProviderInstanceId.make("otherDriver");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("prefers an unprobed (warning) instance over one whose probe errored", () => {
    const notInstalled = ProviderInstanceId.make("testDriver");
    const unprobed = ProviderInstanceId.make("otherDriver");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: unprobed,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(unprobed);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("testDriver");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: "otherDriver" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("testDriver");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("testDriver");
    const unavailable = ProviderInstanceId.make("otherDriver");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("testDriver"), instanceId: "testDriver" }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("otherDriver");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: "testDriver",
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: "otherDriver" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "otherDriver",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("returns undefined when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("otherDriver"), instanceId: "otherDriver" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("otherDriver"),
    );
    expect(resolved).toBeUndefined();
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "otherDriver",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("otherDriver"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  it.each([
    ["codex", "codex", "gpt-5.6"],
    ["claudeAgent", "claudeAgent", "claude-fable-5"],
    ["cursor", "cursor", "composer-2"],
  ])("uses the only available %s instance", (driver, instanceId, modelSlug) => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: [model(modelSlug, false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId,
      model: modelSlug,
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "otherDriver",
        models: [model("claude-opus-4-8")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("otherDriver"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("testDriver"),
        instanceId: "testDriver",
        status: "warning",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("otherDriver"),
        instanceId: "otherDriver",
        models: [model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "otherDriver", model: "claude-opus-4-8" });
  });

  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("testDriver"),
          instanceId: "testDriver",
          models: [model("gpt-5.6")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("otherDriver"),
          instanceId: "otherDriver",
          models: [model("claude-opus-4-8", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("testDriver"),
          model: "gpt-5.6",
        }),
      ).toEqual({ instanceId: "otherDriver", model: "claude-opus-4-8" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("testDriver"),
            instanceId: "testDriver",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("testDriver"),
            instanceId: "testDriver",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("testDriver"),
            instanceId: "testDriver",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
