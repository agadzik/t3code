import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type FxSettings,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import { acpPermissionDisposition, type AcpPermissionDisposition } from "./AcpClientPolicy.ts";
import type * as ProviderAdapter from "../../orchestration-v2/ProviderAdapter.ts";

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
/** T3 slug for "whatever model fx is configured to run". Never sent on the wire. */
export const FX_DEFAULT_MODEL_SLUG = "default";
/** Config ids observed on session/new. `provider` (the fx backend) is absent on purpose: fx owns it in v1. */
export const FX_MODEL_CONFIG_ID = "model";
export const FX_EFFORT_CONFIG_ID = "effort";

/** The only two mode ids fx advertises. */
export type FxSessionMode = "ask" | "code";

/**
 * The T3 runtime modes fx offers. Full access is left out (maintainer decision, 2026-10-05).
 * Web and mobile hide unlisted modes. In production RuntimePolicy runs an unlisted mode as
 * approval-required; the test replay harness does not, so fxRuntimeModeOf normalizes again.
 * Keep approval-required first: the composer displays the first listed mode for a thread
 * whose stored mode is unlisted.
 */
export const FX_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
] as const satisfies ReadonlyArray<RuntimeMode>;
export type FxRuntimeMode = (typeof FX_SUPPORTED_RUNTIME_MODES)[number];

/** One row per supported mode. Adding a mode to the list without a row is a compile error. */
export const FX_SESSION_MODE_BY_RUNTIME_MODE = {
  "approval-required": "ask",
  // T3 allows edit-kind requests and asks for the rest (AcpClientPolicy).
  "auto-accept-edits": "ask",
  auto: "code",
} as const satisfies Record<FxRuntimeMode, FxSessionMode>;

/**
 * Static composer control. `default` is T3-only: configureSession skips select
 * values the live session does not advertise, so fx keeps its own effort.
 */
export const FX_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: FX_EFFORT_CONFIG_ID,
  label: "Effort",
  type: "select",
  options: [
    { id: "default", label: "fx setting", isDefault: true },
    { id: "auto", label: "Auto" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
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
  // No --model: the model is a session config option, so resume and in-session switch share one path.
  return { command: settings.binaryPath || "fx", args: ["acp"], cwd, env: { ...environment } };
}

/**
 * The one place an unlisted mode becomes approval-required for fx, mirroring RuntimePolicy's clamp.
 * Both hooks below read the mode through it, so a full-access policy can never reach
 * acpPermissionDisposition, which would allow every request.
 */
export function fxRuntimeModeOf(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy): FxRuntimeMode {
  const mode = policy.runtimeMode;
  for (const supported of FX_SUPPORTED_RUNTIME_MODES) {
    if (mode === supported) return supported;
  }
  return "approval-required";
}

/** Explicit approval or sandbox overrides force `ask` so T3 sees every mutation (Grok precedent). */
export function fxSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): FxSessionMode {
  if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) {
    return "ask";
  }
  return FX_SESSION_MODE_BY_RUNTIME_MODE[fxRuntimeModeOf(policy)];
}

/** In `code` fx already allowed what its own policy allows, so under Auto whatever it still asks reaches the user. */
export function fxPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const mode = fxRuntimeModeOf(policy);
  if (mode === "auto" && fxSessionModeForPolicy(policy) === "code") {
    return "ask";
  }
  return acpPermissionDisposition({ ...policy, runtimeMode: mode }, request);
}

/**
 * Writes config id `model` by id, never the first `category: "model"` option (that is `provider`).
 * The default slug resolves to `fxDefaultModel`, the model the latest `fx status --json` reported,
 * so choosing Default after a concrete model restores fx's own choice on a resumed session too.
 * Idempotent: a target equal to the live value writes nothing.
 * An id the live session does not advertise (the user switched fx backend outside T3) logs a
 * warning and keeps the current model, so a stale catalog cannot wedge a thread.
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
    const option = options.find((entry) => entry.id === FX_MODEL_CONFIG_ID && entry.type === "select");
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
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
