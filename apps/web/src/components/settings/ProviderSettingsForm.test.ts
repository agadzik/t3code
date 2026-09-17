import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { getDriverOption } from "./providerDriverMeta";
import { deriveProviderSettingsFields } from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("returns no fields when a driver has no settings schema", () => {
    const option = getDriverOption(ProviderDriverKind.make("testDriver"));
    expect(option).toBeDefined();
    expect(deriveProviderSettingsFields(option!)).toEqual([]);
  });

  it("derives the optional fx model field and hides enabled", () => {
    const option = getDriverOption(ProviderDriverKind.make("fx"));
    expect(option).toBeDefined();
    expect(deriveProviderSettingsFields(option!)).toEqual([
      {
        key: "model",
        control: "text",
        label: "Default model",
        description:
          "AI Gateway model id used for new threads. Set the FX_API_KEY environment variable on this instance (marked sensitive) to authenticate.",
        placeholder: "anthropic/claude-sonnet-4",
        clearWhenEmpty: "omit",
      },
    ]);
  });
});
