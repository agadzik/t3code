/**
 * FxAdapter - ProviderAdapter over an fx runner process per thread.
 *
 * One session = one runner = one libfx agent. The adapter translates the
 * runner's frames into canonical `ProviderRuntimeEvent`s and keeps each
 * `ProviderSession` honest: `running` only while a prompt is in flight,
 * `resumeCursor` only once the runner has handed back a checkpoint.
 */
import {
  EventId,
  type ItemLifecyclePayload,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderInstanceId,
  ProviderDriverKind,
  RuntimeItemId,
  type ThreadId,
  TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import type { RunnerFrame, RunnerTurnEvent, RunnerTurnUsage } from "@t3tools/fx-runner/protocol";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type * as EventNdjsonLogger from "./EventNdjsonLogger.ts";
import type { FxRunnerLauncher, FxRunnerLink } from "./FxRunnerLink.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
const PROVIDER = FX_DRIVER_KIND;

/** Persisted per-thread resume state: the agent's opaque libfx checkpoint. */
export const FxResumeCursor = Schema.Struct({
  checkpointBase64: Schema.String.check(Schema.isMinLength(1)),
});
export type FxResumeCursor = typeof FxResumeCursor.Type;
const decodeResumeCursor = Schema.decodeUnknownEffect(FxResumeCursor);

export interface FxAdapterConfig {
  readonly instanceId: ProviderInstanceId;
  readonly apiKey: string | undefined;
  readonly model: string | undefined;
}

export interface FxAdapterOptions {
  readonly launcher: FxRunnerLauncher;
  readonly nativeEventLogger?: EventNdjsonLogger.EventNdjsonLogger | undefined;
}

interface ActiveTurn {
  readonly turnId: TurnId;
}

interface FxSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly link: FxRunnerLink;
  session: ProviderSession;
  activeTurn: ActiveTurn | null;
  stopped: boolean;
}

type ToolItemType = Extract<
  ItemLifecyclePayload["itemType"],
  "command_execution" | "file_change" | "dynamic_tool_call"
>;

/** Which canonical item a runner tool renders as, keyed by tool name. */
const TOOL_ITEM_TYPES: Readonly<Record<string, ToolItemType>> = {
  shell: "command_execution",
  writeFile: "file_change",
  editFile: "file_change",
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

/**
 * Item payload for a runner tool call. `data` follows the shape clients
 * already read for other providers: `command` for command executions,
 * `path` for file changes, `rawOutput.content` for the result text.
 */
export function toolItemPayload(
  event: Extract<RunnerTurnEvent, { type: "tool_start" | "tool_end" }>,
): ItemLifecyclePayload {
  const itemType = TOOL_ITEM_TYPES[event.name] ?? "dynamic_tool_call";
  const input = event.type === "tool_start" ? asRecord(event.input) : undefined;
  const command = stringField(input, "command");
  const path = stringField(input, "path");
  const titleDetail = command ?? path ?? stringField(input, "pattern");
  const title = titleDetail ? `${event.name}: ${titleDetail}` : event.name;
  const status: ItemLifecyclePayload["status"] =
    event.type === "tool_start" ? "inProgress" : event.isError ? "failed" : "completed";
  const content = event.type === "tool_end" ? event.content : undefined;
  return {
    itemType,
    status,
    title,
    ...(content !== undefined && content.trim().length > 0 ? { detail: content } : {}),
    data: {
      toolName: event.name,
      ...(input !== undefined ? { input } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(content !== undefined ? { rawOutput: { content } } : {}),
    },
  };
}

export function turnTokenUsage(usage: RunnerTurnUsage | undefined): TurnTokenUsage {
  const optional = {
    ...(usage?.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteTokens }
      : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...optional,
    };
  }
  return {
    usageScope: "main_agent",
    usageStatus: usage === undefined ? "unavailable" : "partial",
    hasSubagents: false,
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...optional,
  };
}

export type FxAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export function makeFxAdapter(config: FxAdapterConfig, options: FxAdapterOptions) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sessions = new Map<ThreadId, FxSessionContext>();
    const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = crypto.randomUUIDv4.pipe(
      Effect.map((id) => EventId.make(id)),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate an fx runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = threadLocks.get(threadId);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          threadLocks.set(threadId, lock);
        }
        return lock.withPermits(1)(effect);
      });

    const emit = (
      threadId: ThreadId,
      event: Omit<ProviderRuntimeEvent, "eventId" | "createdAt" | "provider" | "threadId">,
    ) =>
      Effect.gen(function* () {
        const runtimeEvent = {
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: config.instanceId,
          threadId,
          ...event,
        } as ProviderRuntimeEvent;
        yield* PubSub.publish(runtimeEventPubSub, runtimeEvent);
      }).pipe(Effect.ignoreCause({ log: true }));

    const logNative = (threadId: ThreadId, frame: RunnerFrame) =>
      options.nativeEventLogger?.write({ provider: PROVIDER, frame }, threadId) ?? Effect.void;

    const touch = (ctx: FxSessionContext, patch: Partial<ProviderSession>) =>
      Effect.map(nowIso, (updatedAt) => {
        ctx.session = { ...ctx.session, ...patch, updatedAt };
      });

    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        return ctx && !ctx.stopped
          ? Effect.succeed(ctx)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
      });

    const settleTurn = (
      ctx: FxSessionContext,
      turnId: TurnId,
      outcome:
        | {
            readonly kind: "completed";
            readonly stopReason: string;
            readonly usage: RunnerTurnUsage | undefined;
          }
        | { readonly kind: "aborted" }
        | { readonly kind: "failed"; readonly message: string },
    ) =>
      Effect.gen(function* () {
        ctx.activeTurn = null;
        yield* touch(ctx, {
          status: outcome.kind === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          ...(outcome.kind === "failed"
            ? { lastError: outcome.message }
            : { lastError: undefined }),
        });
        switch (outcome.kind) {
          case "completed":
            return yield* emit(ctx.threadId, {
              type: "turn.completed",
              turnId,
              payload: {
                state: "completed",
                stopReason: outcome.stopReason,
                tokenUsage: turnTokenUsage(outcome.usage),
              },
            });
          case "aborted":
            return yield* emit(ctx.threadId, {
              type: "turn.aborted",
              turnId,
              payload: { reason: "interrupted" },
            });
          case "failed":
            return yield* emit(ctx.threadId, {
              type: "turn.completed",
              turnId,
              payload: { state: "failed", errorMessage: outcome.message },
            });
        }
      });

    const handleFrame = (ctx: FxSessionContext, frame: RunnerFrame) =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, frame);
        switch (frame.type) {
          case "ready":
            return;
          case "event": {
            const turnId = TurnId.make(frame.turnId);
            const event = frame.event;
            switch (event.type) {
              case "text_delta":
                return yield* emit(ctx.threadId, {
                  type: "content.delta",
                  turnId,
                  payload: { streamKind: "assistant_text", delta: event.delta },
                });
              case "reasoning_delta":
                return yield* emit(ctx.threadId, {
                  type: "content.delta",
                  turnId,
                  payload: { streamKind: "reasoning_text", delta: event.delta },
                });
              case "tool_start":
                return yield* emit(ctx.threadId, {
                  type: "item.started",
                  turnId,
                  itemId: RuntimeItemId.make(event.id),
                  payload: toolItemPayload(event),
                });
              case "tool_end":
                return yield* emit(ctx.threadId, {
                  type: "item.completed",
                  turnId,
                  itemId: RuntimeItemId.make(event.id),
                  payload: toolItemPayload(event),
                });
            }
            return;
          }
          case "turnResult": {
            const turnId = TurnId.make(frame.turnId);
            if (frame.checkpointBase64 !== undefined) {
              const resumeCursor: FxResumeCursor = { checkpointBase64: frame.checkpointBase64 };
              yield* touch(ctx, { resumeCursor });
            }
            if (frame.stopReason === "cancelled") {
              return yield* settleTurn(ctx, turnId, { kind: "aborted" });
            }
            if (frame.stopReason === "error") {
              return yield* settleTurn(ctx, turnId, {
                kind: "failed",
                message: frame.errorMessage ?? "fx turn failed",
              });
            }
            return yield* settleTurn(ctx, turnId, {
              kind: "completed",
              stopReason: frame.stopReason,
              usage: frame.usage,
            });
          }
          case "error": {
            const active = ctx.activeTurn;
            if (frame.turnId !== undefined && active !== null && active.turnId === frame.turnId) {
              return yield* settleTurn(ctx, active.turnId, {
                kind: "failed",
                message: frame.message,
              });
            }
            if (frame.fatal) {
              yield* touch(ctx, { status: "error", lastError: frame.message });
              return yield* emit(ctx.threadId, {
                type: "runtime.error",
                payload: { message: frame.message, class: "provider_error" },
              });
            }
            return yield* emit(ctx.threadId, {
              type: "runtime.warning",
              payload: { message: frame.message },
            });
          }
        }
      });

    /** The runner went away without a stop request: fail the turn and report the exit. */
    const handleLinkLost = (ctx: FxSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        const active = ctx.activeTurn;
        if (active !== null) {
          yield* settleTurn(ctx, active.turnId, {
            kind: "failed",
            message: "fx runner exited while the turn was running",
          });
        }
        yield* touch(ctx, { status: "error", lastError: "fx runner exited unexpectedly" });
        yield* emit(ctx.threadId, {
          type: "session.state.changed",
          payload: { state: "error", reason: "fx runner exited unexpectedly" },
        });
        yield* emit(ctx.threadId, {
          type: "session.exited",
          payload: { exitKind: "error", recoverable: ctx.session.resumeCursor !== undefined },
        });
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const stopSessionInternal = (ctx: FxSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        yield* ctx.link.send({ type: "close" }).pipe(Effect.ignore);
        yield* touch(ctx, { status: "closed", activeTurnId: undefined });
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        yield* emit(ctx.threadId, { type: "session.exited", payload: { exitKind: "graceful" } });
      });

    const startSession: FxAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Provider mismatch: expected '${PROVIDER}', received '${input.provider}'.`,
            });
          }
          const apiKey = config.apiKey;
          if (apiKey === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "No API key configured. Set the FX_API_KEY environment variable on this provider instance.",
            });
          }
          if (input.cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "A working directory is required to start an fx session.",
            });
          }
          const resumeCursor =
            input.resumeCursor === undefined || input.resumeCursor === null
              ? undefined
              : yield* decodeResumeCursor(input.resumeCursor).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterValidationError({
                        provider: PROVIDER,
                        operation: "startSession",
                        issue: "Persisted fx resume state is malformed.",
                        cause,
                      }),
                  ),
                );
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const model = input.modelSelection?.model ?? config.model;
          const cwd = input.cwd;
          const sessionScope = yield* Scope.make("sequential");
          return yield* Effect.gen(function* () {
            const link = yield* options.launcher
              .launch({ threadId: input.threadId, cwd })
              .pipe(Effect.provideService(Scope.Scope, sessionScope));
            yield* link.send({
              type: "init",
              apiKey,
              ...(model !== undefined ? { model } : {}),
              rootDir: cwd,
              ...(resumeCursor !== undefined
                ? { checkpointBase64: resumeCursor.checkpointBase64 }
                : {}),
            });

            const createdAt = yield* nowIso;
            const ctx: FxSessionContext = {
              threadId: input.threadId,
              scope: sessionScope,
              link,
              session: {
                provider: PROVIDER,
                providerInstanceId: config.instanceId,
                status: "connecting",
                runtimeMode: input.runtimeMode,
                cwd,
                ...(model !== undefined ? { model } : {}),
                threadId: input.threadId,
                ...(resumeCursor !== undefined ? { resumeCursor } : {}),
                createdAt,
                updatedAt: createdAt,
              },
              activeTurn: null,
              stopped: false,
            };

            // The first frame decides whether the agent came up. Later frames
            // flow through the pump fiber for the life of the session.
            const readyResult = yield* Deferred.make<void, ProviderAdapterProcessError>();
            yield* link.frames.pipe(
              Stream.runForEach((frame) =>
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(readyResult)) {
                    return yield* handleFrame(ctx, frame);
                  }
                  yield* logNative(ctx.threadId, frame);
                  if (frame.type === "ready") {
                    yield* Deferred.succeed(readyResult, undefined);
                    return;
                  }
                  yield* Deferred.fail(
                    readyResult,
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail:
                        frame.type === "error"
                          ? frame.message
                          : `Unexpected first runner frame '${frame.type}'.`,
                    }),
                  );
                }),
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  yield* Deferred.fail(
                    readyResult,
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "fx runner closed the connection before it was ready.",
                    }),
                  );
                  yield* handleLinkLost(ctx);
                }),
              ),
              Effect.forkIn(sessionScope),
            );
            yield* Deferred.await(readyResult);

            yield* touch(ctx, { status: "ready" });
            sessions.set(input.threadId, ctx);
            yield* emit(input.threadId, {
              type: "session.started",
              payload: resumeCursor !== undefined ? { resume: resumeCursor } : {},
            });
            yield* emit(input.threadId, {
              type: "session.state.changed",
              payload: { state: "ready", reason: "fx runner ready" },
            });
            yield* emit(input.threadId, { type: "thread.started", payload: {} });
            return ctx.session;
          }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)));
        }),
      );

    const sendTurn: FxAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.activeTurn !== null) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Turn '${ctx.activeTurn.turnId}' is still running on thread '${input.threadId}'.`,
            });
          }
          if (input.input === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "The fx provider requires prompt text for every turn.",
            });
          }
          const turnId = TurnId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "crypto/randomUUIDv4",
                    detail: "Failed to generate an fx turn id.",
                    cause,
                  }),
              ),
            ),
          );
          yield* ctx.link.send({ type: "prompt", turnId, input: input.input });
          ctx.activeTurn = { turnId };
          yield* touch(ctx, { status: "running", activeTurnId: turnId, lastError: undefined });
          yield* emit(input.threadId, {
            type: "turn.started",
            turnId,
            payload: ctx.session.model !== undefined ? { model: ctx.session.model } : {},
          });
          if (input.attachments !== undefined && input.attachments.length > 0) {
            yield* emit(input.threadId, {
              type: "runtime.warning",
              turnId,
              payload: {
                message: `The fx provider does not support attachments yet; ${input.attachments.length} attachment(s) were not sent.`,
              },
            });
          }
          return {
            threadId: input.threadId,
            turnId,
            ...(ctx.session.resumeCursor !== undefined
              ? { resumeCursor: ctx.session.resumeCursor }
              : {}),
          };
        }),
      );

    const interruptTurn: FxAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const target = turnId ?? ctx.activeTurn?.turnId;
        if (target === undefined) return;
        yield* ctx.link.send({ type: "interrupt", turnId: target });
      });

    const unsupported = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: `The fx provider does not support ${operation}.`,
        }),
      );

    const stopSession: FxAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: FxAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ctx.session));

    const hasSession: FxAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    /**
     * libfx keeps history inside the opaque checkpoint and exposes no reader,
     * so a restored session has no turn list to hand back. The event log is
     * the durable transcript; this only confirms the thread is live.
     */
    const readThread: FxAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map(() => ({ threadId, turns: [] })));

    const stopAll: FxAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => unsupported("respondToRequest"),
      respondToUserInput: () => unsupported("respondToUserInput"),
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread: () => unsupported("rollbackThread"),
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies FxAdapterShape;
  });
}
