/**
 * Wire protocol between the T3 server (host) and an fx runner process.
 *
 * Frames are JSON text messages over one WebSocket. The host opens the
 * connection with `Authorization: Bearer <token>`, where the token was
 * handed to the runner at spawn time through `FX_RUNNER_TOKEN`. One runner
 * owns exactly one fx agent, so one connection serves one conversation.
 *
 * The runner announces its port on stdout as one NDJSON line matching
 * `RunnerListening` before it accepts connections.
 */
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const RunnerListening = Schema.Struct({
  type: Schema.Literal("listening"),
  port: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type RunnerListening = typeof RunnerListening.Type;

export const HostInitFrame = Schema.Struct({
  type: Schema.Literal("init"),
  apiKey: NonEmptyString,
  model: Schema.optional(NonEmptyString),
  rootDir: NonEmptyString,
  instructions: Schema.optional(Schema.String),
  checkpointBase64: Schema.optional(NonEmptyString),
});
export type HostInitFrame = typeof HostInitFrame.Type;

export const HostPromptFrame = Schema.Struct({
  type: Schema.Literal("prompt"),
  turnId: NonEmptyString,
  input: NonEmptyString,
});

export const HostInterruptFrame = Schema.Struct({
  type: Schema.Literal("interrupt"),
  turnId: NonEmptyString,
});

export const HostCloseFrame = Schema.Struct({
  type: Schema.Literal("close"),
});

export const HostFrame = Schema.Union([
  HostInitFrame,
  HostPromptFrame,
  HostInterruptFrame,
  HostCloseFrame,
]);
export type HostFrame = typeof HostFrame.Type;

export const RunnerTurnEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text_delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning_delta"), delta: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_start"),
    id: NonEmptyString,
    name: NonEmptyString,
    input: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_end"),
    id: NonEmptyString,
    name: NonEmptyString,
    content: Schema.optional(Schema.String),
    isError: Schema.Boolean,
  }),
]);
export type RunnerTurnEvent = typeof RunnerTurnEvent.Type;

export const RunnerTurnUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Int),
  outputTokens: Schema.optional(Schema.Int),
  cacheReadTokens: Schema.optional(Schema.Int),
  cacheWriteTokens: Schema.optional(Schema.Int),
  reasoningTokens: Schema.optional(Schema.Int),
});
export type RunnerTurnUsage = typeof RunnerTurnUsage.Type;

export const RunnerReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  model: Schema.optional(NonEmptyString),
});

export const RunnerEventFrame = Schema.Struct({
  type: Schema.Literal("event"),
  turnId: NonEmptyString,
  event: RunnerTurnEvent,
});

/**
 * Terminal frame for one prompt. `stopReason` is libfx's value verbatim
 * ("end_turn", "cancelled", ...) or "error" when the turn's result rejected,
 * in which case `errorMessage` carries the cause. `checkpointBase64` is the
 * agent's conversation state after the turn; absent when the checkpoint
 * failed, so the host keeps whatever it persisted last.
 */
export const RunnerTurnResultFrame = Schema.Struct({
  type: Schema.Literal("turnResult"),
  turnId: NonEmptyString,
  stopReason: NonEmptyString,
  usage: Schema.optional(RunnerTurnUsage),
  checkpointBase64: Schema.optional(NonEmptyString),
  errorMessage: Schema.optional(NonEmptyString),
});
export type RunnerTurnResultFrame = typeof RunnerTurnResultFrame.Type;

export const RunnerErrorFrame = Schema.Struct({
  type: Schema.Literal("error"),
  message: NonEmptyString,
  turnId: Schema.optional(NonEmptyString),
  fatal: Schema.Boolean,
});

export const RunnerFrame = Schema.Union([
  RunnerReadyFrame,
  RunnerEventFrame,
  RunnerTurnResultFrame,
  RunnerErrorFrame,
]);
export type RunnerFrame = typeof RunnerFrame.Type;

export const decodeHostFrame = Schema.decodeUnknownSync(Schema.fromJsonString(HostFrame));
export const encodeHostFrame = Schema.encodeSync(Schema.fromJsonString(HostFrame));
export const decodeRunnerFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RunnerFrame));
export const encodeRunnerFrame = Schema.encodeSync(Schema.fromJsonString(RunnerFrame));
export const decodeRunnerListening = Schema.decodeUnknownSync(
  Schema.fromJsonString(RunnerListening),
);
export const encodeRunnerListening = Schema.encodeSync(Schema.fromJsonString(RunnerListening));

export const FX_RUNNER_TOKEN_ENV = "FX_RUNNER_TOKEN";
