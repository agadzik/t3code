import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { HostFrame, RunnerFrame } from "@t3tools/fx-runner/protocol";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  type FxAdapterShape,
  makeFxAdapter,
  toolItemPayload,
  turnTokenUsage,
} from "./FxAdapter.ts";
import type { FxRunnerLauncher, FxRunnerLink } from "./FxRunnerLink.ts";

const FX = ProviderDriverKind.make("fx");
const instanceId = ProviderInstanceId.make("fx");

interface FakeRunner {
  readonly cwd: string;
  readonly sent: HostFrame[];
  readonly push: (frame: RunnerFrame) => Effect.Effect<void>;
  readonly end: Effect.Effect<void>;
  readonly closed: Deferred.Deferred<void>;
}

/** In-memory runner: answers `init` by itself, everything else is test-driven. */
function makeFakeLauncher(options?: { readonly initReply?: RunnerFrame }) {
  const runners: FakeRunner[] = [];
  const launcher: FxRunnerLauncher = {
    launch: (input) =>
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<RunnerFrame, Cause.Done>();
        const closed = yield* Deferred.make<void>();
        const sent: HostFrame[] = [];
        const runner: FakeRunner = {
          cwd: input.cwd,
          sent,
          push: (frame) => Queue.offer(frames, frame).pipe(Effect.asVoid),
          end: Queue.end(frames).pipe(Effect.asVoid),
          closed,
        };
        runners.push(runner);
        yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined).pipe(Effect.asVoid));
        const link: FxRunnerLink = {
          send: (frame) =>
            Effect.gen(function* () {
              sent.push(frame);
              if (frame.type === "init") {
                yield* Queue.offer(
                  frames,
                  options?.initReply ?? { type: "ready", model: frame.model },
                );
              }
              if (frame.type === "close") {
                yield* Queue.end(frames);
              }
            }),
          frames: Stream.fromQueue(frames),
          close: Effect.void,
        };
        return link;
      }),
  };
  return { launcher, runners };
}

const collectEvents = Effect.fn("collectEvents")(function* (adapter: FxAdapterShape) {
  const events: ProviderRuntimeEvent[] = [];
  const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => {
      events.push(event);
    }),
  ).pipe(Effect.forkChild);
  // Let the subscription attach before anything publishes.
  yield* Effect.yieldNow;
  const waitFor = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      while (!events.some(predicate)) yield* Effect.yieldNow;
    });
  return { events, fiber, waitFor };
});

const makeAdapter = (
  launcher: FxRunnerLauncher,
  config?: { readonly apiKey?: string | undefined; readonly model?: string | undefined },
) =>
  makeFxAdapter(
    {
      instanceId,
      apiKey: config && "apiKey" in config ? config.apiKey : "key-123",
      model: config?.model,
    },
    { launcher },
  );

const startInput = (threadId: ThreadId) =>
  ({
    threadId,
    provider: FX,
    providerInstanceId: instanceId,
    cwd: "/work/project",
    runtimeMode: "full-access",
  }) as const;

describe("FxAdapter", () => {
  it.effect("starts a session through the runner and reports it ready", () =>
    Effect.gen(function* () {
      const { launcher, runners } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher, { model: "anthropic/claude-sonnet-4" });
      const { events, fiber } = yield* collectEvents(adapter);
      const threadId = ThreadId.make("thread-1");

      const session = yield* adapter.startSession(startInput(threadId));

      assert.deepEqual(runners[0]!.sent, [
        {
          type: "init",
          apiKey: "key-123",
          model: "anthropic/claude-sonnet-4",
          rootDir: "/work/project",
        },
      ]);
      assert.equal(runners[0]!.cwd, "/work/project");
      assert.equal(session.status, "ready");
      assert.equal(session.model, "anthropic/claude-sonnet-4");
      assert.equal(session.cwd, "/work/project");
      assert.equal(session.resumeCursor, undefined);
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "maps a full turn to runtime events and keeps the checkpoint as the resume cursor",
    () =>
      Effect.gen(function* () {
        const { launcher, runners } = makeFakeLauncher();
        const adapter = yield* makeAdapter(launcher);
        const { events, fiber, waitFor } = yield* collectEvents(adapter);
        const threadId = ThreadId.make("thread-2");
        yield* adapter.startSession(startInput(threadId));
        const runner = runners[0]!;

        const turn = yield* adapter.sendTurn({ threadId, input: "list files" });
        const prompt = runner.sent.at(-1);
        assert.equal(prompt?.type, "prompt");
        const turnId = prompt?.type === "prompt" ? prompt.turnId : "";
        assert.equal(turn.turnId, turnId);
        assert.equal(turn.resumeCursor, undefined);
        const running = (yield* adapter.listSessions())[0]!;
        assert.equal(running.status, "running");
        assert.equal(running.activeTurnId, turnId);

        yield* runner.push({
          type: "event",
          turnId,
          event: { type: "reasoning_delta", delta: "plan" },
        });
        yield* runner.push({
          type: "event",
          turnId,
          event: { type: "text_delta", delta: "Listing" },
        });
        yield* runner.push({
          type: "event",
          turnId,
          event: { type: "tool_start", id: "call-1", name: "shell", input: { command: "ls" } },
        });
        yield* runner.push({
          type: "event",
          turnId,
          event: {
            type: "tool_end",
            id: "call-1",
            name: "shell",
            content: "a.ts\n[exit code 0]",
            isError: false,
          },
        });
        yield* runner.push({
          type: "turnResult",
          turnId,
          stopReason: "end_turn",
          usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 3 },
          checkpointBase64: "Y2hlY2twb2ludA==",
        });
        yield* waitFor((event) => event.type === "turn.completed");

        const afterTurn = events.slice(3);
        assert.deepEqual(
          afterTurn.map((event) => event.type),
          [
            "turn.started",
            "content.delta",
            "content.delta",
            "item.started",
            "item.completed",
            "turn.completed",
          ],
        );
        const [, reasoning, text, itemStarted, itemCompleted, completed] = afterTurn;
        assert.equal(reasoning?.turnId, turnId);
        assert.deepEqual(reasoning?.type === "content.delta" ? reasoning.payload : null, {
          streamKind: "reasoning_text",
          delta: "plan",
        });
        assert.deepEqual(text?.type === "content.delta" ? text.payload : null, {
          streamKind: "assistant_text",
          delta: "Listing",
        });
        assert.equal(itemStarted?.itemId, "call-1");
        assert.deepEqual(itemStarted?.type === "item.started" ? itemStarted.payload : null, {
          itemType: "command_execution",
          status: "inProgress",
          title: "shell: ls",
          data: { toolName: "shell", input: { command: "ls" }, command: "ls" },
        });
        assert.deepEqual(itemCompleted?.type === "item.completed" ? itemCompleted.payload : null, {
          itemType: "command_execution",
          status: "completed",
          title: "shell",
          detail: "a.ts\n[exit code 0]",
          data: { toolName: "shell", rawOutput: { content: "a.ts\n[exit code 0]" } },
        });
        assert.deepEqual(completed?.type === "turn.completed" ? completed.payload : null, {
          state: "completed",
          stopReason: "end_turn",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 20,
            outputTokens: 7,
            cachedInputTokens: 3,
          },
        });

        const ready = (yield* adapter.listSessions())[0]!;
        assert.equal(ready.status, "ready");
        assert.equal(ready.activeTurnId, undefined);
        assert.deepEqual(ready.resumeCursor, { checkpointBase64: "Y2hlY2twb2ludA==" });

        const secondTurn = yield* adapter.sendTurn({ threadId, input: "again" });
        assert.deepEqual(secondTurn.resumeCursor, { checkpointBase64: "Y2hlY2twb2ludA==" });
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("interrupts the active turn and reports the cancelled result as aborted", () =>
    Effect.gen(function* () {
      const { launcher, runners } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher);
      const { events, fiber, waitFor } = yield* collectEvents(adapter);
      const threadId = ThreadId.make("thread-3");
      yield* adapter.startSession(startInput(threadId));
      const runner = runners[0]!;
      const turn = yield* adapter.sendTurn({ threadId, input: "long task" });

      yield* adapter.interruptTurn(threadId);
      assert.deepEqual(runner.sent.at(-1), { type: "interrupt", turnId: turn.turnId });
      yield* runner.push({ type: "turnResult", turnId: turn.turnId, stopReason: "cancelled" });
      yield* waitFor((event) => event.type === "turn.aborted");

      const aborted = events.at(-1);
      assert.equal(aborted?.turnId, turn.turnId);
      assert.deepEqual(aborted?.type === "turn.aborted" ? aborted.payload : null, {
        reason: "interrupted",
      });
      const session = (yield* adapter.listSessions())[0]!;
      assert.equal(session.status, "ready");
      assert.equal(session.resumeCursor, undefined);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops a session with a close frame and tears the runner down", () =>
    Effect.gen(function* () {
      const { launcher, runners } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher);
      const { events, fiber, waitFor } = yield* collectEvents(adapter);
      const threadId = ThreadId.make("thread-4");
      yield* adapter.startSession(startInput(threadId));
      const runner = runners[0]!;

      yield* adapter.stopSession(threadId);
      assert.deepEqual(runner.sent.at(-1), { type: "close" });
      yield* Deferred.await(runner.closed);
      yield* waitFor((event) => event.type === "session.exited");
      const exited = events.at(-1);
      assert.deepEqual(exited?.type === "session.exited" ? exited.payload : null, {
        exitKind: "graceful",
      });
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.deepEqual(yield* adapter.listSessions(), []);
      // Stopping twice is a no-op, not an error.
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores a session from a persisted checkpoint and rejects malformed cursors", () =>
    Effect.gen(function* () {
      const { launcher, runners } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher);
      const threadId = ThreadId.make("thread-5");

      const session = yield* adapter.startSession({
        ...startInput(threadId),
        resumeCursor: { checkpointBase64: "cmVzdW1l" },
      });
      assert.deepEqual(runners[0]!.sent[0], {
        type: "init",
        apiKey: "key-123",
        rootDir: "/work/project",
        checkpointBase64: "cmVzdW1l",
      });
      assert.deepEqual(session.resumeCursor, { checkpointBase64: "cmVzdW1l" });

      const malformed = yield* adapter
        .startSession({ ...startInput(ThreadId.make("thread-5b")), resumeCursor: { nope: 1 } })
        .pipe(Effect.flip);
      assert.equal(malformed._tag, "ProviderAdapterValidationError");
      assert.equal(runners.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to start without an API key and surfaces a fatal runner init error", () =>
    Effect.gen(function* () {
      const { launcher: okLauncher, runners } = makeFakeLauncher();
      const noKey = yield* makeAdapter(okLauncher, { apiKey: undefined });
      const noKeyError = yield* noKey
        .startSession(startInput(ThreadId.make("thread-6")))
        .pipe(Effect.flip);
      assert.equal(noKeyError._tag, "ProviderAdapterValidationError");
      assert.include(noKeyError.message, "FX_API_KEY");
      assert.equal(runners.length, 0);

      const { launcher: failingLauncher, runners: failingRunners } = makeFakeLauncher({
        initReply: { type: "error", message: "invalid api key", fatal: true },
      });
      const adapter = yield* makeAdapter(failingLauncher);
      const threadId = ThreadId.make("thread-6b");
      const initError = yield* adapter.startSession(startInput(threadId)).pipe(Effect.flip);
      assert.equal(initError._tag, "ProviderAdapterProcessError");
      assert.include(initError.message, "invalid api key");
      yield* Deferred.await(failingRunners[0]!.closed);
      assert.equal(yield* adapter.hasSession(threadId), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the running turn and exits the session when the runner disappears", () =>
    Effect.gen(function* () {
      const { launcher, runners } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher);
      const { events, fiber, waitFor } = yield* collectEvents(adapter);
      const threadId = ThreadId.make("thread-7");
      yield* adapter.startSession(startInput(threadId));
      const turn = yield* adapter.sendTurn({ threadId, input: "work" });

      yield* runners[0]!.end;
      yield* waitFor((event) => event.type === "session.exited");

      const tail = events.slice(-3);
      assert.deepEqual(
        tail.map((event) => event.type),
        ["turn.completed", "session.state.changed", "session.exited"],
      );
      const [failed, state, exited] = tail;
      assert.equal(failed?.turnId, turn.turnId);
      assert.deepEqual(failed?.type === "turn.completed" ? failed.payload : null, {
        state: "failed",
        errorMessage: "fx runner exited while the turn was running",
      });
      assert.equal(state?.type === "session.state.changed" ? state.payload.state : null, "error");
      assert.deepEqual(exited?.type === "session.exited" ? exited.payload : null, {
        exitKind: "error",
        recoverable: false,
      });
      assert.equal(yield* adapter.hasSession(threadId), false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a second turn while one is running and turns without text", () =>
    Effect.gen(function* () {
      const { launcher } = makeFakeLauncher();
      const adapter = yield* makeAdapter(launcher);
      const threadId = ThreadId.make("thread-8");
      yield* adapter.startSession(startInput(threadId));
      yield* adapter.sendTurn({ threadId, input: "first" });
      const second = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.flip);
      assert.equal(second._tag, "ProviderAdapterValidationError");
      assert.include(second.message, "still running");
      const noText = yield* adapter.sendTurn({ threadId, continuation: true }).pipe(Effect.flip);
      assert.equal(noText._tag, "ProviderAdapterValidationError");
      const unknown = yield* adapter
        .sendTurn({ threadId: ThreadId.make("nope"), input: "x" })
        .pipe(Effect.flip);
      assert.equal(unknown._tag, "ProviderAdapterSessionNotFoundError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("FxAdapter payload mapping", () => {
  it("renders file tools as file changes with the path, other tools as dynamic calls", () => {
    assert.deepEqual(
      toolItemPayload({
        type: "tool_start",
        id: "1",
        name: "editFile",
        input: { path: "src/a.ts" },
      }),
      {
        itemType: "file_change",
        status: "inProgress",
        title: "editFile: src/a.ts",
        data: { toolName: "editFile", input: { path: "src/a.ts" }, path: "src/a.ts" },
      },
    );
    assert.deepEqual(
      toolItemPayload({ type: "tool_end", id: "2", name: "grep", content: "", isError: true }),
      {
        itemType: "dynamic_tool_call",
        status: "failed",
        title: "grep",
        data: { toolName: "grep", rawOutput: { content: "" } },
      },
    );
  });

  it("marks usage partial or unavailable when libfx omits totals", () => {
    assert.deepEqual(turnTokenUsage(undefined), {
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: false,
    });
    assert.deepEqual(turnTokenUsage({ outputTokens: 4, reasoningTokens: 2 }), {
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      outputTokens: 4,
      reasoningTokens: 2,
    });
  });
});
