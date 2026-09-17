/**
 * libfx@0.0.10 ships no type declarations. This covers the surface the
 * runner uses, transcribed from the package README and `fx-sdk.js`.
 */
declare module "libfx/node" {
  export type FxTurnEvent =
    | { readonly type: "text_delta"; readonly delta: string }
    | { readonly type: "reasoning_delta"; readonly delta: string }
    | { readonly type: "tool_start"; readonly id: string; readonly name: string }
    | {
        readonly type: "tool_end";
        readonly id: string;
        readonly name: string;
        readonly content?: string;
        readonly isError: boolean;
      };

  export interface FxTurnUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
  }

  export interface FxTurnResult {
    readonly stopReason: string;
    readonly usage?: FxTurnUsage;
  }

  export interface FxTurn extends AsyncIterable<FxTurnEvent> {
    readonly result: Promise<FxTurnResult>;
    cancel(): void;
  }

  export interface FxHostTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly execute: (
      input: unknown,
      context: { readonly signal: AbortSignal },
    ) => Promise<unknown> | unknown;
  }

  export interface FxAgent {
    prompt(input: string, options?: { readonly signal?: AbortSignal }): FxTurn;
    checkpoint(): Promise<Uint8Array>;
    close(): Promise<void>;
  }

  export interface CreateFxAgentOptions {
    readonly apiKey: string;
    readonly model?: string;
    readonly instructions?: string;
    readonly tools?: ReadonlyArray<FxHostTool>;
    readonly checkpoint?: Uint8Array;
    readonly backend?: "auto" | "native" | "wasm";
    readonly onEvent?: (event: { readonly type: string } & Record<string, unknown>) => void;
  }

  export function createFxAgent(options: CreateFxAgentOptions): Promise<FxAgent>;

  export function listModels(options: {
    readonly apiKey: string;
    readonly fetch?: typeof globalThis.fetch;
  }): Promise<ReadonlyArray<string>>;
}
