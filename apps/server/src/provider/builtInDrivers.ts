/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * The `ProviderInstanceRegistry` iterates this array when resolving
 * `providerInstances` entries; anything not in the array surfaces as an
 * `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add it to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * @module provider/builtInDrivers
 */
import { FxDriver, type FxDriverEnv } from "./Drivers/FxDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver.
 */
export type BuiltInDriversEnv = FxDriverEnv;

/**
 * Ordered list of built-in drivers.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [FxDriver];
