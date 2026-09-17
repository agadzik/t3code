import { describe, expect, it } from "vite-plus/test";

import { ToolCallCorrelator } from "./toolCallCorrelator.ts";

describe("ToolCallCorrelator", () => {
  it("pairs a start with an input that arrives later", () => {
    const correlator = new ToolCallCorrelator();
    expect(correlator.onStart("t1", "shell")).toBeNull();
    expect(correlator.onInput("shell", { command: "ls" })).toEqual({
      id: "t1",
      name: "shell",
      input: { command: "ls" },
    });
    expect(correlator.onEnd("t1", "shell")).toBeNull();
  });

  it("pairs an input with a start that arrives later", () => {
    const correlator = new ToolCallCorrelator();
    expect(correlator.onInput("readFile", { path: "a" })).toBeNull();
    expect(correlator.onStart("t2", "readFile")).toEqual({
      id: "t2",
      name: "readFile",
      input: { path: "a" },
    });
  });

  it("pairs parallel calls of one tool in FIFO order", () => {
    const correlator = new ToolCallCorrelator();
    correlator.onStart("t1", "grep");
    correlator.onStart("t2", "grep");
    expect(correlator.onInput("grep", { pattern: "first" })?.id).toBe("t1");
    expect(correlator.onInput("grep", { pattern: "second" })?.id).toBe("t2");
  });

  it("reports a start that never received an input when the call ends", () => {
    const correlator = new ToolCallCorrelator();
    correlator.onStart("t3", "unknownTool");
    expect(correlator.onEnd("t3", "unknownTool")).toEqual({ id: "t3", name: "unknownTool" });
    expect(correlator.onEnd("t3", "unknownTool")).toBeNull();
  });

  it("forgets pending pairs on reset", () => {
    const correlator = new ToolCallCorrelator();
    correlator.onStart("t4", "shell");
    correlator.reset();
    expect(correlator.onInput("shell", {})).toBeNull();
  });
});
