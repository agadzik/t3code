import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTIONS, FX_DRIVER_KIND, getDriverOption } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("registers fx as a selectable driver with a lowercase label", () => {
    expect(DRIVER_OPTIONS.map((option) => option.value)).toEqual([FX_DRIVER_KIND]);
    expect(getDriverOption(FX_DRIVER_KIND)).toMatchObject({
      value: FX_DRIVER_KIND,
      label: "fx",
    });
  });

  it("keeps unknown drivers renderable without an fx schema", () => {
    const option = getDriverOption(ProviderDriverKind.make("testDriver"));
    expect(option).toMatchObject({
      value: ProviderDriverKind.make("testDriver"),
      label: "Test Driver",
    });
    expect(option?.settingsSchema).toBeUndefined();
  });
});
