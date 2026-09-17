import {
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  type ProviderSetupInput,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const unavailable = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly operation: string;
}) =>
  new ProviderSetupError({
    instanceId: input.instanceId,
    operation: input.operation,
    detail: "Managed installation is not available for this provider instance.",
  });

/** Route instance setup to a driver-owned installer. This build ships none. */
export const makeProviderInstallation = () =>
  Effect.succeed({
    start: (input: ProviderSetupInput) =>
      Effect.fail(unavailable({ instanceId: input.instanceId, operation: "install" })),
    cancel: (input: ProviderInstallCancelInput) =>
      Effect.fail(unavailable({ instanceId: input.instanceId, operation: "cancel-install" })),
    subscribe: (input: ProviderSetupInput) =>
      Stream.fail(unavailable({ instanceId: input.instanceId, operation: "observe-install" })),
    remove: (input: ProviderSetupInput) =>
      Effect.fail(unavailable({ instanceId: input.instanceId, operation: "remove-install" })),
  });
