/**
 * Shape of a JavaScript tool as libfx's `createFxAgent({ tools })` accepts
 * it. Returning a string hands that text to the model; throwing marks the
 * call failed with the error message as content.
 */
export interface HostTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (
    input: unknown,
    context: { readonly signal: AbortSignal },
  ) => Promise<string> | string;
}

export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}
