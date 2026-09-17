/**
 * Scripted stand-in for libfx's agent so runner tests never touch the
 * network or the native addon. Each prompt plays the steps the script
 * returns for its input; tool steps call the host tools the runner supplied,
 * matching how libfx dispatches `execute` right after `tool_start`.
 */
import type {
  CreateFxAgentOptions,
  FxAgent,
  FxHostTool,
  FxTurn,
  FxTurnEvent,
  FxTurnResult,
} from "libfx/node";

export type FakeStep =
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "reasoning"; readonly delta: string }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }
  | { readonly kind: "hang" }
  | { readonly kind: "fail"; readonly message: string };

export interface FakeFx {
  readonly createAgent: (options: CreateFxAgentOptions) => Promise<FxAgent>;
  readonly created: CreateFxAgentOptions[];
  readonly prompts: string[];
  readonly closed: () => number;
}

export function checkpointFor(prompts: ReadonlyArray<string>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ prompts }));
}

export function makeFakeFx(script: (input: string) => ReadonlyArray<FakeStep>): FakeFx {
  const created: CreateFxAgentOptions[] = [];
  const prompts: string[] = [];
  let closed = 0;

  const createAgent = async (options: CreateFxAgentOptions): Promise<FxAgent> => {
    created.push(options);
    if (options.apiKey === "reject-me") throw new Error("invalid api key");
    const tools = new Map<string, FxHostTool>(
      (options.tools ?? []).map((tool) => [tool.name, tool]),
    );
    let nextCallId = 0;
    return {
      prompt: (input) => {
        prompts.push(input);
        return playTurn(script(input), tools, () => `call-${(nextCallId += 1)}`);
      },
      checkpoint: async () => checkpointFor(prompts),
      close: async () => {
        closed += 1;
      },
    };
  };

  return { createAgent, created, prompts, closed: () => closed };
}

function playTurn(
  steps: ReadonlyArray<FakeStep>,
  tools: ReadonlyMap<string, FxHostTool>,
  nextCallId: () => string,
): FxTurn {
  const controller = new AbortController();
  let resolveResult: (result: FxTurnResult) => void = () => {};
  let rejectResult: (error: unknown) => void = () => {};
  const result = new Promise<FxTurnResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});

  async function* events(): AsyncGenerator<FxTurnEvent> {
    try {
      for (const step of steps) {
        if (controller.signal.aborted) break;
        switch (step.kind) {
          case "text":
            yield { type: "text_delta", delta: step.delta };
            break;
          case "reasoning":
            yield { type: "reasoning_delta", delta: step.delta };
            break;
          case "tool": {
            const id = nextCallId();
            yield { type: "tool_start", id, name: step.name };
            const tool = tools.get(step.name);
            let content: string;
            let isError = false;
            try {
              if (!tool) throw new Error(`unknown host tool: ${step.name}`);
              const value = await tool.execute(step.input, { signal: controller.signal });
              content = typeof value === "string" ? value : JSON.stringify(value);
            } catch (error) {
              isError = true;
              content = error instanceof Error ? error.message : String(error);
            }
            yield { type: "tool_end", id, name: step.name, content, isError };
            break;
          }
          case "hang":
            await new Promise<void>((resolve) => {
              if (controller.signal.aborted) resolve();
              else controller.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            break;
          case "fail":
            throw new Error(step.message);
        }
      }
      // libfx reports no usage for a cancelled turn.
      resolveResult(
        controller.signal.aborted
          ? { stopReason: "cancelled" }
          : { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 5 } },
      );
    } catch (error) {
      rejectResult(error);
      throw error;
    }
  }

  const iterator = events();
  return {
    result,
    cancel: () => controller.abort(),
    [Symbol.asyncIterator]: () => iterator,
  };
}
