import { describe, expect, it } from "vite-plus/test";

import {
  decodeHostFrame,
  decodeRunnerFrame,
  decodeRunnerListening,
  encodeHostFrame,
  encodeRunnerFrame,
  type HostFrame,
  type RunnerFrame,
} from "./protocol.ts";

describe("protocol framing", () => {
  it("round-trips every host frame through JSON", () => {
    const frames: ReadonlyArray<HostFrame> = [
      { type: "init", apiKey: "k", rootDir: "/w", model: "m", checkpointBase64: "AAEC" },
      { type: "prompt", turnId: "turn-1", input: "hello" },
      { type: "interrupt", turnId: "turn-1" },
      { type: "close" },
    ];
    for (const frame of frames) {
      expect(decodeHostFrame(encodeHostFrame(frame))).toEqual(frame);
    }
  });

  it("round-trips every runner frame through JSON", () => {
    const frames: ReadonlyArray<RunnerFrame> = [
      { type: "ready", model: "m" },
      { type: "event", turnId: "turn-1", event: { type: "text_delta", delta: "hi" } },
      { type: "event", turnId: "turn-1", event: { type: "reasoning_delta", delta: "hm" } },
      {
        type: "event",
        turnId: "turn-1",
        event: { type: "tool_start", id: "c1", name: "shell", input: { command: "ls" } },
      },
      {
        type: "event",
        turnId: "turn-1",
        event: { type: "tool_end", id: "c1", name: "shell", content: "ok", isError: false },
      },
      {
        type: "turnResult",
        turnId: "turn-1",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 4 },
        checkpointBase64: "AAEC",
      },
      { type: "error", message: "boom", fatal: true },
    ];
    for (const frame of frames) {
      expect(decodeRunnerFrame(encodeRunnerFrame(frame))).toEqual(frame);
    }
  });

  it("rejects unknown frame types, missing fields, and non-JSON", () => {
    expect(() => decodeHostFrame('{"type":"dance"}')).toThrow();
    expect(() => decodeHostFrame('{"type":"prompt","turnId":"t"}')).toThrow();
    expect(() => decodeHostFrame('{"type":"init","apiKey":"","rootDir":"/w"}')).toThrow();
    expect(() => decodeRunnerFrame("not json")).toThrow();
    expect(() => decodeRunnerListening('{"type":"listening","port":0}')).toThrow();
    expect(decodeRunnerListening('{"type":"listening","port":4321}')).toEqual({
      type: "listening",
      port: 4321,
    });
  });
});
