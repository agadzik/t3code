/**
 * Transport-agnostic runner core. Owns one fx agent and drives it from host
 * frames. `main.ts` wires it to a WebSocket and the real libfx; tests wire it
 * to a fake agent factory and capture the frames it sends.
 */
import type { CreateFxAgentOptions, FxAgent, FxTurn, FxTurnEvent, FxTurnUsage } from "libfx/node";

import type { HostFrame, HostInitFrame, RunnerFrame, RunnerTurnUsage } from "./protocol.ts";
import { ToolCallCorrelator } from "./toolCallCorrelator.ts";
import type { HostTool } from "./tools/types.ts";

export type RunnerPhase = "awaiting-init" | "ready" | "prompting" | "closed";

type RunnerState =
  | { readonly phase: "awaiting-init" }
  | { readonly phase: "ready"; readonly agent: FxAgent; readonly model: string | undefined }
  | {
      readonly phase: "prompting";
      readonly agent: FxAgent;
      readonly model: string | undefined;
      readonly turnId: string;
      readonly turn: FxTurn;
      readonly done: Promise<void>;
    }
  | { readonly phase: "closed" };

export interface RunnerServiceOptions {
  readonly createAgent: (options: CreateFxAgentOptions) => Promise<FxAgent>;
  readonly makeTools: (rootDir: string) => ReadonlyArray<HostTool>;
  readonly send: (frame: RunnerFrame) => void;
}

export interface RunnerService {
  readonly phase: RunnerPhase;
  /** Dispatch one host frame. Resolves once the frame is accepted, not once a turn ends. */
  readonly handle: (frame: HostFrame) => Promise<void>;
  /** Resolves once no turn is in flight. */
  readonly whenIdle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function defaultInstructions(rootDir: string): string {
  return [
    `You are a coding agent working inside the directory ${rootDir}.`,
    "Use the shell, readFile, writeFile, editFile, listDir, grep, and glob tools to inspect and change the project. Every path you pass is relative to that directory.",
    "Read before you edit, keep changes minimal, and verify them by running the project's own commands with shell.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const text = String(error);
  return text.length > 0 ? text : "Unknown error";
}

function usageFromResult(usage: FxTurnUsage | undefined): RunnerTurnUsage | undefined {
  if (!usage) return undefined;
  const entries = Object.entries(usage).filter((entry): entry is [string, number] =>
    Number.isSafeInteger(entry[1]),
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function makeRunnerService(options: RunnerServiceOptions): RunnerService {
  let state: RunnerState = { phase: "awaiting-init" };
  const send = options.send;
  const correlator = new ToolCallCorrelator();
  let activeTurnId: string | undefined;

  const emitToolStart = (turnId: string, start: { id: string; name: string; input?: unknown }) =>
    send({ type: "event", turnId, event: { type: "tool_start", ...start } });

  const wrapTool = (tool: HostTool): HostTool => ({
    ...tool,
    execute: (input, context) => {
      const paired = correlator.onInput(tool.name, input);
      if (paired && activeTurnId !== undefined) emitToolStart(activeTurnId, paired);
      return tool.execute(input, context);
    },
  });

  const forward = (turnId: string, event: FxTurnEvent) => {
    switch (event.type) {
      case "text_delta":
      case "reasoning_delta":
        send({ type: "event", turnId, event });
        return;
      case "tool_start": {
        const paired = correlator.onStart(event.id, event.name);
        if (paired) emitToolStart(turnId, paired);
        return;
      }
      case "tool_end": {
        const unpaired = correlator.onEnd(event.id, event.name);
        if (unpaired) emitToolStart(turnId, unpaired);
        send({
          type: "event",
          turnId,
          event: {
            type: "tool_end",
            id: event.id,
            name: event.name,
            ...(event.content !== undefined ? { content: event.content } : {}),
            isError: event.isError,
          },
        });
        return;
      }
    }
  };

  const init = async (frame: HostInitFrame) => {
    if (state.phase !== "awaiting-init") {
      send({ type: "error", message: "Runner is already initialized.", fatal: false });
      return;
    }
    try {
      const agent = await options.createAgent({
        apiKey: frame.apiKey,
        ...(frame.model !== undefined ? { model: frame.model } : {}),
        instructions: frame.instructions ?? defaultInstructions(frame.rootDir),
        tools: options.makeTools(frame.rootDir).map(wrapTool),
        ...(frame.checkpointBase64 !== undefined
          ? { checkpoint: new Uint8Array(Buffer.from(frame.checkpointBase64, "base64")) }
          : {}),
      });
      state = { phase: "ready", agent, model: frame.model };
      send({ type: "ready", ...(frame.model !== undefined ? { model: frame.model } : {}) });
    } catch (error) {
      send({
        type: "error",
        message: `Failed to create fx agent: ${errorMessage(error)}`,
        fatal: true,
      });
    }
  };

  const runTurn = async (
    agent: FxAgent,
    model: string | undefined,
    turnId: string,
    input: string,
  ) => {
    correlator.reset();
    activeTurnId = turnId;
    const turn = agent.prompt(input);
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    state = { phase: "prompting", agent, model, turnId, turn, done };
    try {
      for await (const event of turn) forward(turnId, event);
      const result = await turn.result;
      let checkpointBase64: string | undefined;
      // checkpoint() is idle-only in libfx; a cancelled turn leaves history untouched.
      if (result.stopReason !== "cancelled") {
        try {
          checkpointBase64 = Buffer.from(await agent.checkpoint()).toString("base64");
        } catch (error) {
          send({
            type: "error",
            turnId,
            message: `Checkpoint failed: ${errorMessage(error)}`,
            fatal: false,
          });
        }
      }
      const usage = usageFromResult(result.usage);
      send({
        type: "turnResult",
        turnId,
        stopReason: result.stopReason,
        ...(usage !== undefined ? { usage } : {}),
        ...(checkpointBase64 !== undefined ? { checkpointBase64 } : {}),
      });
    } catch (error) {
      send({ type: "turnResult", turnId, stopReason: "error", errorMessage: errorMessage(error) });
    } finally {
      activeTurnId = undefined;
      if (state.phase === "prompting") state = { phase: "ready", agent, model };
      settle();
    }
  };

  const close = async () => {
    const current = state;
    state = { phase: "closed" };
    if (current.phase === "closed" || current.phase === "awaiting-init") return;
    if (current.phase === "prompting") {
      current.turn.cancel();
      await current.done;
    }
    await current.agent.close().catch(() => {});
  };

  const handle = async (frame: HostFrame): Promise<void> => {
    switch (frame.type) {
      case "init":
        await init(frame);
        return;
      case "prompt": {
        if (state.phase !== "ready") {
          send({
            type: "error",
            turnId: frame.turnId,
            message:
              state.phase === "prompting"
                ? `A turn is already running (${state.turnId}).`
                : `Runner cannot accept a prompt while ${state.phase}.`,
            fatal: false,
          });
          return;
        }
        void runTurn(state.agent, state.model, frame.turnId, frame.input);
        return;
      }
      case "interrupt":
        if (state.phase === "prompting" && state.turnId === frame.turnId) state.turn.cancel();
        return;
      case "close":
        await close();
        return;
    }
  };

  return {
    get phase() {
      return state.phase;
    },
    handle,
    whenIdle: () => (state.phase === "prompting" ? state.done : Promise.resolve()),
    close,
  };
}
