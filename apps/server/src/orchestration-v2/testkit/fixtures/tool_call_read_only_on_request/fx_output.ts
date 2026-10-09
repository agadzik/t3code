import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

const PROBE_FILE = ".codex-probe-write-action.txt";

export function assertToolCallReadOnlyOnRequestFxOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);

  assert.lengthOf(projection.runtimeRequests, 1, "the write must ask for permission exactly once");
  const request = projection.runtimeRequests[0];
  assert.equal(request?.status, "resolved");
  assert.equal(request?.decision, "accept");
  assert.include(["command", "file-change"], request?.kind);

  const writes = projection.turnItems.filter((item) =>
    request?.kind === "command"
      ? item.type === "command_execution" && item.input.includes(PROBE_FILE)
      : item.type === "file_change" && item.fileName.endsWith(PROBE_FILE),
  );
  assert.isNotEmpty(writes, "the approved write must project a matching item");
  assert.isTrue(
    writes.some((item) => item.status === "completed"),
    "the approved write must complete",
  );

  const permissionKinds = transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const frame = entry.frame as {
      method?: unknown;
      params?: { toolCall?: { kind?: unknown } };
    };
    return frame.method === "session/request_permission" ? [frame.params?.toolCall?.kind] : [];
  });
  assert.deepEqual(permissionKinds, ["edit"], "fx must ask T3 before its own write");
}
