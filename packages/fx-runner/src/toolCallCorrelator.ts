/**
 * libfx reports `tool_start { id, name }` on the turn stream but hands the
 * tool input only to the host tool's `execute(input)`. The two arrive in
 * either order, so this pairs them FIFO per tool name and yields one
 * `tool_start` carrying the input. libfx dispatches host tools in the order
 * it emits their `tool_call` updates, which is what makes per-name FIFO
 * pairing correct for parallel calls of the same tool.
 */
export interface CorrelatedToolStart {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
}

export class ToolCallCorrelator {
  readonly #pendingStarts = new Map<string, string[]>();
  readonly #pendingInputs = new Map<string, unknown[]>();

  /** A stream `tool_start`. Emits when the input already arrived. */
  onStart(id: string, name: string): CorrelatedToolStart | null {
    const inputs = this.#pendingInputs.get(name);
    if (inputs !== undefined && inputs.length > 0) {
      const input = inputs.shift();
      if (inputs.length === 0) this.#pendingInputs.delete(name);
      return { id, name, input };
    }
    const starts = this.#pendingStarts.get(name) ?? [];
    starts.push(id);
    this.#pendingStarts.set(name, starts);
    return null;
  }

  /** A host tool `execute` call. Emits when the stream start already arrived. */
  onInput(name: string, input: unknown): CorrelatedToolStart | null {
    const starts = this.#pendingStarts.get(name);
    if (starts !== undefined && starts.length > 0) {
      const id = starts.shift()!;
      if (starts.length === 0) this.#pendingStarts.delete(name);
      return { id, name, input };
    }
    const inputs = this.#pendingInputs.get(name) ?? [];
    inputs.push(input);
    this.#pendingInputs.set(name, inputs);
    return null;
  }

  /**
   * A stream `tool_end`. Returns the start that never paired (libfx refused
   * the call before `execute` ran) so the caller can still emit it first.
   */
  onEnd(id: string, name: string): CorrelatedToolStart | null {
    const starts = this.#pendingStarts.get(name);
    if (starts === undefined) return null;
    const index = starts.indexOf(id);
    if (index === -1) return null;
    starts.splice(index, 1);
    if (starts.length === 0) this.#pendingStarts.delete(name);
    return { id, name };
  }

  reset(): void {
    this.#pendingStarts.clear();
    this.#pendingInputs.clear();
  }
}
