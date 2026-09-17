/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * This build ships no first-party drivers. The `ProviderInstanceRegistry`
 * still iterates this array when resolving `providerInstances` entries;
 * anything not in the array surfaces as an `"unavailable"` shadow snapshot
 * at runtime (see `buildUnavailableProviderSnapshot`).
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add it to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * @module provider/builtInDrivers
 */
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. Empty while this build ships zero drivers.
 */
export type BuiltInDriversEnv = never;

/**
 * Ordered list of built-in drivers. Empty until a driver is registered.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [];
