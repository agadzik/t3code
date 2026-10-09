// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { FxSettings } from "@t3tools/provider-fx/settings";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import {
  FX_DRIVER_KIND,
  FxProviderCapabilitiesV2,
  makeFxAdapterV2,
} from "@t3tools/provider-fx/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const recordedConfigOptions = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../../../../packages/provider-fx/src/server/fx-session-config-options.json",
    ),
    "utf8",
  ),
) as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const testLayer = layerTestProviderHost().pipe(
  Layer.provide(NodeServices.layer),
  Layer.merge(IdAllocator.layer),
  Layer.merge(NodeServices.layer),
);

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>"): Frame => ({
  type: "expect_outbound",
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown): Frame => ({
  type: "emit_inbound",
  frame: { kind: "response", method, result },
});

function withCurrent(
  configId: string,
  value: string,
  base: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = recordedConfigOptions,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return base.map((option) =>
    option.id === configId && option.type === "select"
      ? { ...option, currentValue: value }
      : option,
  );
}

const post1189ModeValues = ["auto", "ask", "full-access"] as const;

function withModeAdvertisement(
  currentValue: string,
  values: ReadonlyArray<string> = post1189ModeValues,
  base: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = recordedConfigOptions,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return base.map((option) =>
    option.id === "mode" && option.type === "select"
      ? {
          ...option,
          currentValue,
          options: values.map((value) => ({ value, name: value })),
        }
      : option,
  );
}

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true, acp: true },
  },
  agentInfo: { name: "fx", title: "fx", version: "0.0.13" },
  authMethods: [],
};

describe("FxAdapterV2", () => {
  it("does not switch runtime mode or steer in session", () => {
    expect(FxProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession).toBe(false);
    expect(FxProviderCapabilitiesV2.turns.supportsActiveSteering).toBe(false);
  });

  const openReplay = Effect.fn("openFxReplay")(function* (input: {
    readonly scenario: string;
    readonly entries: ReadonlyArray<Frame>;
    readonly initialNativeThreadId?: string;
    readonly runtimeMode?: RuntimeMode;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  }) {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fx-adapter-" });
    const statusPath = path.join(replayDir, "status.json");
    const transcript = yield* decodeAcpReplayTranscript(
      {
        provider: FX_DRIVER_KIND,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: input.scenario,
        entries: input.entries as never,
      },
      FX_DRIVER_KIND,
    );
    const instanceId = ProviderInstanceId.make("fx");
    const adapter = yield* makeFxAdapterV2({
      instanceId,
      settings: decodeFxSettings({ enabled: true }),
      environment: {},
      selfInvocation: yield* resolveSelfInvocation(),
      currentFxDefaultModel: Effect.succeed("anthropic/claude-opus-5.5"),
      makeRuntime: makeAcpReplayRuntime({
        transcript,
        statusPath,
        scriptPath: yield* path.fromFileUrl(
          new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
        ),
        childProcessSpawner,
        fileSystem,
      }),
    });
    yield* adapter
      .openSession({
        threadId: ThreadId.make("thread-fx"),
        providerSessionId: ProviderSessionId.make("provider-session-fx"),
        modelSelection: {
          instanceId,
          model: "anthropic/claude-sonnet-5.5",
          options: input.options ?? [{ id: "effort", value: "high" }],
        },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: input.runtimeMode ?? "auto",
          interactionMode: "default",
          cwd: replayDir,
        }),
        ...(input.initialNativeThreadId === undefined
          ? {}
          : { initialNativeThreadId: input.initialNativeThreadId }),
      })
      .pipe(Effect.scoped);
    yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
  });

  it.effect("writes model, effort, and mode after session/new", () =>
    openReplay({
      scenario: "fx-session-new-config",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes effort medium when the selection has no effort", () =>
    openReplay({
      scenario: "fx-session-new-default-effort",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "medium",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "effort",
            "medium",
            withCurrent("model", "anthropic/claude-sonnet-5.5"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes nothing when live effort is already medium", () =>
    openReplay({
      scenario: "fx-session-new-live-medium-effort",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withCurrent("effort", "medium"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "model",
            "anthropic/claude-sonnet-5.5",
            withCurrent("effort", "medium"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code", withCurrent("effort", "medium")),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes effort medium for a stale stored default", () =>
    openReplay({
      scenario: "fx-session-new-stale-default-effort",
      options: [{ id: "effort", value: "default" }],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "medium",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "effort",
            "medium",
            withCurrent("model", "anthropic/claude-sonnet-5.5"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes effort medium on resume when the selection has no effort", () =>
    openReplay({
      scenario: "fx-session-load-default-effort",
      initialNativeThreadId: "fx-session",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/load"),
        answer("session/load", {
          sessionId: "fx-session",
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "model",
            "anthropic/claude-sonnet-5.5",
            withCurrent("effort", "high"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "medium",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "effort",
            "medium",
            withCurrent("model", "anthropic/claude-sonnet-5.5", withCurrent("effort", "high")),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("loads a resumed session with session/load", () =>
    openReplay({
      scenario: "fx-session-load",
      initialNativeThreadId: "fx-session",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/load"),
        answer("session/load", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode ask when a supervised thread reports ask", () =>
    openReplay({
      scenario: "fx-session-new-supervised-mode",
      runtimeMode: "approval-required",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "ask"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode code when an auto thread reports ask", () =>
    openReplay({
      scenario: "fx-session-new-auto-reports-ask",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withCurrent("effort", "medium"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent(
            "model",
            "anthropic/claude-sonnet-5.5",
            withCurrent("effort", "medium"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "code",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "code", withCurrent("effort", "medium")),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode ask on resume when a supervised thread reports ask", () =>
    openReplay({
      scenario: "fx-session-load-supervised-mode",
      initialNativeThreadId: "fx-session",
      runtimeMode: "approval-required",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/load"),
        answer("session/load", { sessionId: "fx-session", configOptions: recordedConfigOptions }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("model", "anthropic/claude-sonnet-5.5"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("effort", "high"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", {
          configOptions: withCurrent("mode", "ask"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode auto when later fx reports auto on an auto thread", () =>
    openReplay({
      scenario: "fx-session-new-auto-reports-auto",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("effort", "medium"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("model", "anthropic/claude-sonnet-5.5", withCurrent("effort", "medium")),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "auto",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("effort", "medium"),
          ),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode ask when later fx reports auto on a supervised thread", () =>
    openReplay({
      scenario: "fx-session-new-supervised-reports-auto",
      runtimeMode: "approval-required",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withModeAdvertisement("auto"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("model", "anthropic/claude-sonnet-5.5"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("effort", "high"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement("ask"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode ask when later fx reports full-access on a supervised thread", () =>
    openReplay({
      scenario: "fx-session-new-supervised-reports-full-access",
      runtimeMode: "approval-required",
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withModeAdvertisement("full-access"),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "full-access",
            post1189ModeValues,
            withCurrent("model", "anthropic/claude-sonnet-5.5"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "effort",
          value: "high",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "full-access",
            post1189ModeValues,
            withCurrent("effort", "high"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "ask",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement("ask"),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("writes mode auto when later fx reports full-access on an auto thread", () =>
    openReplay({
      scenario: "fx-session-new-auto-reports-full-access",
      options: [],
      entries: [
        outbound("initialize"),
        answer("initialize", initializeResult),
        outbound("session/new"),
        answer("session/new", {
          sessionId: "fx-session",
          configOptions: withModeAdvertisement(
            "full-access",
            post1189ModeValues,
            withCurrent("effort", "medium"),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "model",
          value: "anthropic/claude-sonnet-5.5",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "full-access",
            post1189ModeValues,
            withCurrent("model", "anthropic/claude-sonnet-5.5", withCurrent("effort", "medium")),
          ),
        }),
        outbound("session/set_config_option", {
          sessionId: "fx-session",
          configId: "mode",
          value: "auto",
        }),
        answer("session/set_config_option", {
          configOptions: withModeAdvertisement(
            "auto",
            post1189ModeValues,
            withCurrent("effort", "medium"),
          ),
        }),
      ],
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
