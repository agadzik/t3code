import { describe, expect, it } from "vite-plus/test";

import type { RunnerFrame } from "./protocol.ts";
import { makeRunnerService } from "./runnerService.ts";
import { checkpointFor, type FakeStep, makeFakeFx } from "./testing/fakeFx.ts";
import type { HostTool } from "./tools/types.ts";

const echoTool: HostTool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  execute: (input) => `echo:${JSON.stringify(input)}`,
};

function harness(script: (input: string) => ReadonlyArray<FakeStep>) {
  const fx = makeFakeFx(script);
  const frames: RunnerFrame[] = [];
  const service = makeRunnerService({
    createAgent: fx.createAgent,
    makeTools: () => [echoTool],
    send: (frame) => frames.push(frame),
  });
  return { fx, frames, service };
}

describe("runner service", () => {
  it("creates the agent on init with tools, instructions, and the decoded checkpoint", async () => {
    const { fx, frames, service } = harness(() => []);
    const checkpoint = checkpointFor(["earlier"]);
    await service.handle({
      type: "init",
      apiKey: "key",
      model: "openai/gpt-x",
      rootDir: "/work",
      checkpointBase64: Buffer.from(checkpoint).toString("base64"),
    });
    expect(frames).toEqual([{ type: "ready", model: "openai/gpt-x" }]);
    expect(service.phase).toBe("ready");
    const options = fx.created[0]!;
    expect(options.apiKey).toBe("key");
    expect(options.model).toBe("openai/gpt-x");
    expect(options.instructions).toContain("/work");
    expect(options.tools?.map((tool) => tool.name)).toEqual(["echo"]);
    expect(Array.from(options.checkpoint ?? [])).toEqual(Array.from(checkpoint));
  });

  it("reports a fatal error when the agent cannot be created", async () => {
    const { frames, service } = harness(() => []);
    await service.handle({ type: "init", apiKey: "reject-me", rootDir: "/work" });
    expect(frames).toEqual([
      { type: "error", message: "Failed to create fx agent: invalid api key", fatal: true },
    ]);
    expect(service.phase).toBe("awaiting-init");
  });

  it("streams a turn, pairs tool inputs with their ids, and ends with a checkpointed result", async () => {
    const { frames, service } = harness(() => [
      { kind: "reasoning", delta: "thinking" },
      { kind: "text", delta: "Hello" },
      { kind: "tool", name: "echo", input: { n: 1 } },
      { kind: "tool", name: "missing", input: {} },
      { kind: "text", delta: " done" },
    ]);
    await service.handle({ type: "init", apiKey: "key", rootDir: "/work" });
    await service.handle({ type: "prompt", turnId: "turn-1", input: "go" });
    expect(service.phase).toBe("prompting");
    await service.whenIdle();
    expect(service.phase).toBe("ready");
    expect(frames.slice(1)).toEqual([
      { type: "event", turnId: "turn-1", event: { type: "reasoning_delta", delta: "thinking" } },
      { type: "event", turnId: "turn-1", event: { type: "text_delta", delta: "Hello" } },
      {
        type: "event",
        turnId: "turn-1",
        event: { type: "tool_start", id: "call-1", name: "echo", input: { n: 1 } },
      },
      {
        type: "event",
        turnId: "turn-1",
        event: {
          type: "tool_end",
          id: "call-1",
          name: "echo",
          content: 'echo:{"n":1}',
          isError: false,
        },
      },
      {
        type: "event",
        turnId: "turn-1",
        event: { type: "tool_start", id: "call-2", name: "missing" },
      },
      {
        type: "event",
        turnId: "turn-1",
        event: {
          type: "tool_end",
          id: "call-2",
          name: "missing",
          content: "unknown host tool: missing",
          isError: true,
        },
      },
      { type: "event", turnId: "turn-1", event: { type: "text_delta", delta: " done" } },
      {
        type: "turnResult",
        turnId: "turn-1",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 5 },
        checkpointBase64: Buffer.from(checkpointFor(["go"])).toString("base64"),
      },
    ]);
  });

  it("cancels the running turn on interrupt and skips the checkpoint", async () => {
    const { frames, service } = harness(() => [{ kind: "text", delta: "a" }, { kind: "hang" }]);
    await service.handle({ type: "init", apiKey: "key", rootDir: "/work" });
    await service.handle({ type: "prompt", turnId: "turn-1", input: "go" });
    await service.handle({ type: "interrupt", turnId: "other-turn" });
    expect(service.phase).toBe("prompting");
    await service.handle({ type: "interrupt", turnId: "turn-1" });
    await service.whenIdle();
    expect(frames.at(-1)).toEqual({
      type: "turnResult",
      turnId: "turn-1",
      stopReason: "cancelled",
    });
  });

  it("rejects a second prompt while one is running and a prompt before init", async () => {
    const { frames, service } = harness(() => [{ kind: "hang" }]);
    await service.handle({ type: "prompt", turnId: "early", input: "go" });
    expect(frames.at(-1)).toEqual({
      type: "error",
      turnId: "early",
      message: "Runner cannot accept a prompt while awaiting-init.",
      fatal: false,
    });
    await service.handle({ type: "init", apiKey: "key", rootDir: "/work" });
    await service.handle({ type: "prompt", turnId: "turn-1", input: "go" });
    await service.handle({ type: "prompt", turnId: "turn-2", input: "again" });
    expect(frames.at(-1)).toEqual({
      type: "error",
      turnId: "turn-2",
      message: "A turn is already running (turn-1).",
      fatal: false,
    });
    await service.close();
    expect(service.phase).toBe("closed");
  });

  it("reports a rejected turn result as an error stop", async () => {
    const { frames, service } = harness(() => [{ kind: "fail", message: "gateway down" }]);
    await service.handle({ type: "init", apiKey: "key", rootDir: "/work" });
    await service.handle({ type: "prompt", turnId: "turn-1", input: "go" });
    await service.whenIdle();
    expect(frames.at(-1)).toEqual({
      type: "turnResult",
      turnId: "turn-1",
      stopReason: "error",
      errorMessage: "gateway down",
    });
    expect(service.phase).toBe("ready");
  });

  it("closes the agent on close, cancelling any running turn first", async () => {
    const { fx, service } = harness(() => [{ kind: "hang" }]);
    await service.handle({ type: "init", apiKey: "key", rootDir: "/work" });
    await service.handle({ type: "prompt", turnId: "turn-1", input: "go" });
    await service.handle({ type: "close" });
    expect(service.phase).toBe("closed");
    expect(fx.closed()).toBe(1);
  });
});
