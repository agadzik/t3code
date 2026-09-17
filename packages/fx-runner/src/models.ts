// oxlint-disable-next-line typescript/triple-slash-reference -- libfx ships no types; the ambient module must reach every program that imports this file.
/// <reference path="./libfx.d.ts" />
import { listModels } from "libfx/node";

/** Gateway model ids the given key can use. One bounded HTTP request, no agent creation. */
export function listFxModels(input: {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<ReadonlyArray<string>> {
  return listModels(input);
}
