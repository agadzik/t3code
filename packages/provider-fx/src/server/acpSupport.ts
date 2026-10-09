import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { FxSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
export const FX_DEFAULT_MODEL_SLUG = "default";
export const FX_MODEL_CONFIG_ID = "model";
const FX_MODE_CONFIG_ID = "mode";
export const FX_EFFORT_CONFIG_ID = "effort";
const FX_DEFAULT_EFFORT = "medium";
const FX_EFFORT_LEVELS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export type FxEffortLevel = (typeof FX_EFFORT_LEVELS)[number];

function isFxEffortLevel(value: unknown): value is FxEffortLevel {
  return typeof value === "string" && (FX_EFFORT_LEVELS as ReadonlyArray<string>).includes(value);
}

export type FxSessionMode = "ask" | "auto";

export const FX_FALLBACK_RUNTIME_MODE = "approval-required" as const satisfies RuntimeMode;

export const FX_SUPPORTED_RUNTIME_MODES = [
  FX_FALLBACK_RUNTIME_MODE,
  "auto",
] as const satisfies ReadonlyArray<RuntimeMode>;
export type FxRuntimeMode = (typeof FX_SUPPORTED_RUNTIME_MODES)[number];

const FX_SESSION_MODE_BY_RUNTIME_MODE = {
  "approval-required": "ask",
  auto: "auto",
} as const satisfies Record<FxRuntimeMode, FxSessionMode>;

export class FxSessionModeUnavailableError extends Schema.TaggedError<FxSessionModeUnavailableError>()(
  "FxSessionModeUnavailableError",
  {
    requested: Schema.String,
    advertised: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const advertised = this.advertised.length > 0 ? this.advertised.join(", ") : "none";
    return `fx cannot run in mode '${this.requested}'; it advertises ${advertised}.`;
  }
}

export const FX_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: FX_EFFORT_CONFIG_ID,
  label: "Effort",
  type: "select",
  options: [
    { id: "auto", label: "Auto" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
  ],
};

export interface FxAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "cancelBehavior"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fxSettings: Pick<FxSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildFxAcpSpawnInput(
  settings: Pick<FxSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return { command: settings.binaryPath || "fx", args: ["acp"], cwd, env: { ...environment } };
}

function fxRuntimeModeOf(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy): FxRuntimeMode {
  const mode = policy.runtimeMode;
  for (const supported of FX_SUPPORTED_RUNTIME_MODES) {
    if (mode === supported) return supported;
  }
  return FX_FALLBACK_RUNTIME_MODE;
}

export function fxSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): FxSessionMode {
  if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) {
    return "ask";
  }
  return FX_SESSION_MODE_BY_RUNTIME_MODE[fxRuntimeModeOf(policy)];
}

function advertisedFxModeIds(input: {
  readonly availableModes?: ReadonlyArray<{ readonly id: string }>;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}): ReadonlyArray<string> {
  const fromModes = (input.availableModes ?? [])
    .map((mode) => mode.id)
    .filter((id) => id.length > 0);
  if (fromModes.length > 0) {
    return fromModes;
  }
  const option = input.configOptions.find(
    (entry) =>
      entry.type === "select" && (entry.id === FX_MODE_CONFIG_ID || entry.category === "mode"),
  );
  return option === undefined ? [] : collectSessionConfigOptionValues(option);
}

/**
 * Maps a mode id the adapter asks for onto T3's fx semantics. The adapter
 * passes `ask` or `auto` from the runtime policy, and can pass fx 0.0.13's
 * native `code` back when it restores a saved mode. Anything else, such as a
 * plan mode, has no fx equivalent.
 */
export function fxSemanticModeOf(modeId: string): FxSessionMode | undefined {
  switch (modeId) {
    case "ask":
      return "ask";
    case "auto":
    case "code":
      return "auto";
    default:
      return undefined;
  }
}

export function resolveFxSessionModeId(
  semantic: FxSessionMode,
  advertised: ReadonlyArray<string>,
): string | undefined {
  if (semantic === "ask") {
    return advertised.includes("ask") ? "ask" : undefined;
  }
  if (advertised.includes("auto")) {
    return "auto";
  }
  if (advertised.includes("code")) {
    return "code";
  }
  return undefined;
}

/**
 * fx 0.0.13 reports `ask` on new sessions while enforcing its global default
 * until a client writes the mode. Later fx renamed `code` to `auto` and reports
 * the saved permission mode honestly.
 */
export const applyFxSessionMode = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "getConfigOptions" | "setMode" | "request"
  >;
  readonly sessionId: string;
  readonly mode: string;
}): Effect.Effect<void, EffectAcpErrors.AcpError | FxSessionModeUnavailableError> =>
  Effect.gen(function* () {
    const current = yield* input.runtime.getModeState;
    const configOptions = yield* input.runtime.getConfigOptions;
    const advertised = advertisedFxModeIds({
      ...(current === undefined ? {} : { availableModes: current.availableModes }),
      configOptions,
    });
    const semantic = fxSemanticModeOf(input.mode);
    const target =
      semantic === undefined ? undefined : resolveFxSessionModeId(semantic, advertised);
    if (target === undefined) {
      return yield* new FxSessionModeUnavailableError({
        requested: input.mode,
        advertised: [...advertised],
      });
    }
    if (current?.currentModeId !== target) {
      yield* input.runtime.setMode(target);
      return;
    }
    yield* input.runtime.request("session/set_config_option", {
      sessionId: input.sessionId,
      configId: FX_MODE_CONFIG_ID,
      value: target,
    });
  });

export function withFxSessionModeAlwaysWritten(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  const session = { id: undefined as string | undefined };
  const captureSession = <A extends { readonly sessionId: string }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          session.id = result.sessionId;
        }),
      ),
    );

  return {
    ...runtime,
    start: () => captureSession(runtime.start()),
    loadSession: (sessionId, options) => captureSession(runtime.loadSession(sessionId, options)),
    resumeSession: (sessionId, options) =>
      captureSession(runtime.resumeSession(sessionId, options)),
    forkSession: (sessionId, options) => captureSession(runtime.forkSession(sessionId, options)),
    setMode: (modeId) => {
      if (session.id === undefined) {
        return runtime.setMode(modeId);
      }
      return applyFxSessionMode({
        runtime,
        sessionId: session.id,
        mode: modeId,
      }).pipe(
        Effect.mapError((error): EffectAcpErrors.AcpError =>
          error._tag === "FxSessionModeUnavailableError"
            ? new EffectAcpErrors.AcpTransportError({
                method: "session/set_config_option",
                detail: error.message,
                cause: error,
              })
            : error,
        ),
        Effect.as({}),
      );
    },
  };
}

export function fxPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const mode = fxRuntimeModeOf(policy);
  const fxAlreadyApprovedRoutineActions =
    mode === "auto" && fxSessionModeForPolicy(policy) === "auto";
  if (fxAlreadyApprovedRoutineActions) {
    return "ask";
  }
  return acpPermissionDisposition({ ...policy, runtimeMode: mode }, request);
}

/**
 * Writes config id `model` by id, never the first `category: "model"` option (that is `provider`).
 */
export const applyFxModelSelection = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedModel: string;
  readonly fxDefaultModel: string | undefined;
}): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const option = options.find(
      (entry) => entry.id === FX_MODEL_CONFIG_ID && entry.type === "select",
    );
    const current = option?.type === "select" ? option.currentValue : undefined;
    const target =
      input.requestedModel === "" || input.requestedModel === FX_DEFAULT_MODEL_SLUG
        ? input.fxDefaultModel
        : input.requestedModel;
    if (target === undefined || target === current) {
      return current;
    }
    const advertised = option === undefined ? [] : collectSessionConfigOptionValues(option);
    if (!advertised.includes(target)) {
      yield* Effect.logWarning(
        "fx model is not advertised by the live session; keeping the current model",
        { requested: target, current },
      );
      return current;
    }
    yield* input.runtime.setConfigOption(FX_MODEL_CONFIG_ID, target);
    return target;
  });

export const applyFxEffortSelection = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedEffort: unknown;
}): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    if (isFxEffortLevel(input.requestedEffort)) {
      return undefined;
    }
    const options = yield* input.runtime.getConfigOptions;
    const option = options.find(
      (entry) => entry.id === FX_EFFORT_CONFIG_ID && entry.type === "select",
    );
    const current = option?.type === "select" ? option.currentValue : undefined;
    if (current === FX_DEFAULT_EFFORT) {
      return current;
    }
    const advertised = option === undefined ? [] : collectSessionConfigOptionValues(option);
    if (!advertised.includes(FX_DEFAULT_EFFORT)) {
      return current;
    }
    yield* input.runtime.setConfigOption(FX_EFFORT_CONFIG_ID, FX_DEFAULT_EFFORT);
    return FX_DEFAULT_EFFORT;
  });

/** fx docs: wait for the prompt response even after cancel. */
export const makeFxAcpRuntime = (
  input: FxAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { childProcessSpawner, fxSettings, environment, cwd, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        cwd,
        spawn: buildFxAcpSpawnInput(fxSettings, cwd, environment),
        cancelBehavior: "wait-for-prompt",
        ownDetachedProcessGroup: true,
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
