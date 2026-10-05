// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - recorded fx session options live next to the ACP support tests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { FxSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import { FX_DRIVER_KIND } from "../../provider/acp/FxAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { makeFxAdapterV2 } from "./FxAdapterV2.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const recordedConfigOptions = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../provider/acp/fx-session-config-options.json",
    ),
    "utf8",
  ),
) as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fx-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

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
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return recordedConfigOptions.map((option) =>
    option.id === configId && option.type === "select" ? { ...option, currentValue: value } : option,
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
  const openReplay = Effect.fn("openFxReplay")(function* (input: {
    readonly scenario: string;
    readonly entries: ReadonlyArray<Frame>;
    readonly initialNativeThreadId?: string;
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
    const adapter = makeFxAdapterV2({
      instanceId,
      settings: decodeFxSettings({ enabled: true }),
      environment: {},
      childProcessSpawner,
      crypto: yield* Crypto.Crypto,
      selfInvocation: yield* resolveSelfInvocation(),
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
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
          options: [{ id: "effort", value: "high" }],
        },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
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
});
