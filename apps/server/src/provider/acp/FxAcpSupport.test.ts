// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import {
  applyFxEffortSelection,
  applyFxModelSelection,
  buildFxAcpSpawnInput,
  FX_DEFAULT_MODEL_SLUG,
  FX_EFFORT_CONFIG_ID,
  FX_EFFORT_OPTION_DESCRIPTOR,
  FX_FALLBACK_RUNTIME_MODE,
  FX_MODEL_CONFIG_ID,
  FX_SUPPORTED_RUNTIME_MODES,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
} from "./FxAcpSupport.ts";

const recordedConfigOptions = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "fx-session-config-options.json"),
    "utf8",
  ),
) as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

function runtimePolicy(
  runtimeMode: RuntimeMode,
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...override,
  });
}

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function makeRecordingRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = recordedConfigOptions,
) {
  const writes: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  return {
    writes,
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) => {
        writes.push({ configId, value });
        return Effect.succeed({ configOptions });
      },
    },
  };
}

describe("fx session mode", () => {
  it("lists the fallback mode first", () => {
    expect(FX_SUPPORTED_RUNTIME_MODES[0]).toBe(FX_FALLBACK_RUNTIME_MODE);
  });

  it("maps each offered T3 mode onto fx ask or code", () => {
    expect(fxSessionModeForPolicy(runtimePolicy("approval-required"))).toBe("ask");
    expect(fxSessionModeForPolicy(runtimePolicy("auto-accept-edits"))).toBe("ask");
    expect(fxSessionModeForPolicy(runtimePolicy("auto"))).toBe("code");
  });

  it("runs full-access as ask, matching approval-required", () => {
    expect(fxSessionModeForPolicy(runtimePolicy("full-access"))).toBe("ask");
    const edit = permissionRequest("edit");
    const read = permissionRequest("read");
    expect(fxPermissionDisposition(runtimePolicy("full-access"), edit)).toBe("ask");
    expect(fxPermissionDisposition(runtimePolicy("approval-required"), edit)).toBe("ask");
    expect(fxPermissionDisposition(runtimePolicy("full-access"), read)).toBe("allow");
    expect(fxPermissionDisposition(runtimePolicy("approval-required"), read)).toBe("allow");
  });

  it("allows edit-kind requests under auto-accept-edits", () => {
    expect(fxPermissionDisposition(runtimePolicy("auto-accept-edits"), permissionRequest("edit"))).toBe(
      "allow",
    );
  });

  it("leaves Auto prompts to the user unless an explicit policy forced ask", () => {
    expect(fxPermissionDisposition(runtimePolicy("auto"), permissionRequest("read"))).toBe("ask");
    expect(fxPermissionDisposition(runtimePolicy("auto"), permissionRequest("edit"))).toBe("ask");
    const readOnly = runtimePolicy("auto", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(fxSessionModeForPolicy(readOnly)).toBe("ask");
    expect(fxPermissionDisposition(readOnly, permissionRequest("execute"))).toBe("deny");
  });
});

describe("FX_EFFORT_OPTION_DESCRIPTOR", () => {
  it("lists six effort levels with medium as default", () => {
    expect(FX_EFFORT_OPTION_DESCRIPTOR.type).toBe("select");
    if (FX_EFFORT_OPTION_DESCRIPTOR.type !== "select") return;
    expect(FX_EFFORT_OPTION_DESCRIPTOR.options.map((option) => option.id)).toEqual([
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(FX_EFFORT_OPTION_DESCRIPTOR.options.find((option) => option.isDefault)?.id).toBe("medium");
  });
});

describe("buildFxAcpSpawnInput", () => {
  it("spawns fx acp without a model flag", () => {
    expect(buildFxAcpSpawnInput({ binaryPath: "/usr/local/bin/fx" }, "/tmp/project", { HOME: "/tmp/home" })).toEqual({
      command: "/usr/local/bin/fx",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/tmp/home" },
    });
  });
});

describe("applyFxModelSelection", () => {
  it.effect("writes the model config id, not provider", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: "anthropic/claude-sonnet-5.5",
        fxDefaultModel: "anthropic/claude-opus-5.5",
      });
      expect(result).toBe("anthropic/claude-sonnet-5.5");
      expect(writes).toEqual([{ configId: FX_MODEL_CONFIG_ID, value: "anthropic/claude-sonnet-5.5" }]);
    }),
  );

  it.effect("skips the write when the live model already matches", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: "anthropic/claude-opus-5.5",
        fxDefaultModel: "anthropic/claude-opus-5.5",
      });
      expect(result).toBe("anthropic/claude-opus-5.5");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("resolves Default to fx's reported model", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: FX_DEFAULT_MODEL_SLUG,
        fxDefaultModel: "anthropic/claude-sonnet-5.5",
      });
      expect(result).toBe("anthropic/claude-sonnet-5.5");
      expect(writes).toEqual([{ configId: "model", value: "anthropic/claude-sonnet-5.5" }]);
    }),
  );

  it.effect("writes nothing when Default has no probed model", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: FX_DEFAULT_MODEL_SLUG,
        fxDefaultModel: undefined,
      });
      expect(result).toBe("anthropic/claude-opus-5.5");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("keeps the current model for an unadvertised id, including provider values", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: "codex",
        fxDefaultModel: "anthropic/claude-opus-5.5",
      });
      expect(result).toBe("anthropic/claude-opus-5.5");
      expect(writes).toEqual([]);
    }),
  );
});

describe("applyFxEffortSelection", () => {
  it.effect("writes medium when the selection has no effort", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(writes).toEqual([{ configId: FX_EFFORT_CONFIG_ID, value: "medium" }]);
    }),
  );

  it.effect("writes nothing when live effort is already medium", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime(
        recordedConfigOptions.map((option) =>
          option.id === "effort" && option.type === "select" ? { ...option, currentValue: "medium" } : option,
        ),
      );
      yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("writes nothing when the live session does not advertise medium", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime(
        recordedConfigOptions.map((option) => {
          if (option.id !== "effort" || option.type !== "select") return option;
          return {
            ...option,
            options: option.options.filter((entry) => !("value" in entry) || entry.value !== "medium"),
          };
        }),
      );
      yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(writes).toEqual([]);
    }),
  );
});
