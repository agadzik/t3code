import { FxSettings, ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

import { GenericProviderIcon, type Icon } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. The web app renders settings from a schema
 * plus presentation metadata. Unknown slugs still render with a prettified
 * label and the generic glyph.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema?: ProviderSettingsSchema;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate.
   */
  readonly badgeLabel?: string;
}

export type DriverOption = ProviderClientDefinition;

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");

const FX_DRIVER_OPTION = {
  value: FX_DRIVER_KIND,
  label: "fx",
  icon: GenericProviderIcon,
  settingsSchema: FxSettings,
} satisfies ProviderClientDefinition;

/** Selectable drivers in Add provider instance. Coming-soon tiles live in the dialog. */
export const DRIVER_OPTIONS: readonly ProviderClientDefinition[] = [FX_DRIVER_OPTION];

const DRIVER_OPTION_BY_KIND = new Map<ProviderDriverKind, ProviderClientDefinition>(
  DRIVER_OPTIONS.map((option) => [option.value, option]),
);

function humanizeDriverSlug(driver: string): string {
  return driver
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Look up the driver metadata for an instance's `driver` field.
 * Unknown slugs get a prettified label and a generic glyph.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return (
    DRIVER_OPTION_BY_KIND.get(driver) ?? {
      value: driver,
      label: humanizeDriverSlug(driver),
      icon: GenericProviderIcon,
    }
  );
}
