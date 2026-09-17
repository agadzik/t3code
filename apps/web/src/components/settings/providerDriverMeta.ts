import { createElement, type SVGProps } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

import { type Icon } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. The web app renders settings from a schema
 * plus presentation metadata. With no registered drivers this is synthesized
 * from the instance's driver slug so custom and future drivers still render.
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

const GenericProviderIcon: Icon = (props: SVGProps<SVGSVGElement>) =>
  createElement(
    "svg",
    { viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, ...props },
    createElement("rect", {
      x: "3.5",
      y: "5.5",
      width: "17",
      height: "13",
      rx: "3",
      stroke: "currentColor",
      strokeWidth: "1.5",
    }),
    createElement("circle", { cx: "9", cy: "12", r: "1.4", fill: "currentColor" }),
    createElement("circle", { cx: "15", cy: "12", r: "1.4", fill: "currentColor" }),
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
  return {
    value: driver,
    label: humanizeDriverSlug(driver),
    icon: GenericProviderIcon,
  };
}
