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
});
