import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { FxOrchestratorReplayHarness } from "../Adapters/FxAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  assertProviderNativeSubagentRootTurns,
  FX_MODEL_SELECTION,
  materializeFixtureInput,
  READ_ONLY_ON_REQUEST_POLICY,
  WORKSPACE_NEVER_POLICY,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import { simpleInput } from "./fixtures/simple/input.ts";
import { assertSimpleOutput } from "./fixtures/simple/codex_output.ts";
import { multiTurnInput } from "./fixtures/multi_turn/input.ts";
import { assertMultiTurnOutput } from "./fixtures/multi_turn/codex_output.ts";
import { queuedTurnInput } from "./fixtures/queued_turn/input.ts";
import { assertQueuedTurnOutput } from "./fixtures/queued_turn/codex_output.ts";
import { turnInterruptInput } from "./fixtures/turn_interrupt/input.ts";
import { assertTurnInterruptOutput } from "./fixtures/turn_interrupt/codex_output.ts";
import { toolCallReadOnlyOnRequestInput } from "./fixtures/tool_call_read_only_on_request/input.ts";
import { assertToolCallReadOnlyOnRequestFxOutput } from "./fixtures/tool_call_read_only_on_request/fx_output.ts";
import {
  DENIED_WRITE_POLICY,
  TOOL_CALL_DENIED_WRITE_TARGET,
  toolCallDeniedWriteInput,
} from "./fixtures/tool_call_denied_write/input.ts";
import { assertToolCallDeniedWriteFxOutput } from "./fixtures/tool_call_denied_write/fx_output.ts";
import { fxEarlyCancelFollowupInput } from "./fixtures/fx_early_cancel_followup/input.ts";
import { assertFxEarlyCancelFollowupOutput } from "./fixtures/fx_early_cancel_followup/fx_output.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const readTranscript = Effect.fn("readFxOrchestratorReplayTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function normalizeTestError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isStreamingAssistantEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "node.updated":
      return event.payload.kind === "assistant_message" && event.payload.status === "running";
    case "message.updated":
      return event.payload.role === "assistant" && event.payload.streaming;
    case "turn-item.updated":
      return event.payload.type === "assistant_message" && event.payload.streaming;
    default:
      return false;
  }
}

const runFxFixture = Effect.fn("runFxOrchestratorReplayFixture")(function* (input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
}) {
  const recordedTranscript = yield* readTranscript(input.driver.transcriptFile);
  const replayTranscript = materializeReplayTranscriptRuntimeInstructions(recordedTranscript, {
    driver: input.driver.driver,
    model: input.driver.modelSelection.model,
  });
  const fixtureInput = input.buildInput();
  const workspace = yield* checkpointWorkspace(input.fixtureName, fixtureInput.workspaceFiles);
  const transcript = yield* FxOrchestratorReplayHarness.decodeTranscript(replayTranscript);
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput,
    driver: input.driver.driver,
    modelSelection: input.driver.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${input.fixtureName}/${input.driver.driver}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: {
      ...input.driver.runtimePolicyOverride,
      cwd: workspace,
    },
  };
  const result = yield* runOrchestratorV2ProviderReplayScenario(
    scenario,
    FxOrchestratorReplayHarness,
    input.driver.runContinuationWorker === true ? { runContinuationWorker: true } : {},
  ).pipe(provideDeterministicTestRuntime);
  input.driver.assertOutput(result, transcript);
  assertProviderNativeSubagentRootTurns(result);
  const expectedAbsentWorkspacePaths = input.driver.expectedAbsentWorkspacePaths;
  if (expectedAbsentWorkspacePaths !== undefined) {
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const relativePath of expectedAbsentWorkspacePaths) {
        assert.isFalse(
          yield* fs.exists(path.join(workspace, relativePath)),
          `${input.fixtureName}/fx must not create ${relativePath} in the replay workspace`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer));
  }
  assert.isFalse(
    result.domainEvents.some(isStreamingAssistantEvent),
    "buffered delivery must not persist streaming assistant artifacts",
  );
  const projectionThreadId = materialized.projectionThreadIds[0];
  assert.isDefined(projectionThreadId);
  const projection = result.projections.get(projectionThreadId);
  assert.isDefined(projection);
  const latestRun = projection.runs.at(-1);
  assert.deepEqual(latestRun?.modelSelection, input.driver.modelSelection);
});

const fxDriver = ProviderDriverKind.make("fx");

const fxCases: ReadonlyArray<
  readonly [string, () => OrchestratorFixtureInput, ProviderOrchestratorReplayVariant]
> = [
  [
    "simple",
    simpleInput,
    {
      driver: fxDriver,
      transcriptFile: new URL("./fixtures/simple/fx_transcript.ndjson", import.meta.url),
      modelSelection: FX_MODEL_SELECTION,
      assertOutput: assertSimpleOutput,
    },
  ],
  [
    "multi_turn",
    multiTurnInput,
    {
      driver: fxDriver,
      transcriptFile: new URL("./fixtures/multi_turn/fx_transcript.ndjson", import.meta.url),
      modelSelection: FX_MODEL_SELECTION,
      assertOutput: assertMultiTurnOutput,
    },
  ],
  [
    "queued_turn",
    queuedTurnInput,
    {
      driver: fxDriver,
      transcriptFile: new URL("./fixtures/queued_turn/fx_transcript.ndjson", import.meta.url),
      modelSelection: FX_MODEL_SELECTION,
      assertOutput: assertQueuedTurnOutput,
    },
  ],
  [
    "turn_interrupt",
    turnInterruptInput,
    {
      driver: fxDriver,
      transcriptFile: new URL("./fixtures/turn_interrupt/fx_transcript.ndjson", import.meta.url),
      modelSelection: FX_MODEL_SELECTION,
      runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
      assertOutput: assertTurnInterruptOutput,
    },
  ],
  [
    "tool_call_read_only_on_request",
    toolCallReadOnlyOnRequestInput,
    {
      driver: fxDriver,
      transcriptFile: new URL(
        "./fixtures/tool_call_read_only_on_request/fx_transcript.ndjson",
        import.meta.url,
      ),
      modelSelection: FX_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
      assertOutput: assertToolCallReadOnlyOnRequestFxOutput,
    },
  ],
  [
    "tool_call_denied_write",
    toolCallDeniedWriteInput,
    {
      driver: fxDriver,
      transcriptFile: new URL(
        "./fixtures/tool_call_denied_write/fx_transcript.ndjson",
        import.meta.url,
      ),
      modelSelection: FX_MODEL_SELECTION,
      runtimePolicyOverride: DENIED_WRITE_POLICY,
      expectedAbsentWorkspacePaths: [TOOL_CALL_DENIED_WRITE_TARGET],
      assertOutput: assertToolCallDeniedWriteFxOutput,
    },
  ],
  [
    "fx_early_cancel_followup",
    fxEarlyCancelFollowupInput,
    {
      driver: fxDriver,
      transcriptFile: new URL(
        "./fixtures/fx_early_cancel_followup/fx_transcript.ndjson",
        import.meta.url,
      ),
      modelSelection: FX_MODEL_SELECTION,
      runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
      assertOutput: assertFxEarlyCancelFollowupOutput,
    },
  ],
];

describe("fx orchestrator replay fixtures", () => {
  it.effect.each(fxCases)(
    "runs %s/fx through OrchestratorV2 using deterministic replay",
    ([name, buildInput, provider]) =>
      runFxFixture({
        fixtureName: name,
        buildInput,
        driver: provider,
      }).pipe(Effect.mapError(normalizeTestError), Effect.scoped),
  );
});
