import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "./TextGeneration.ts";

/** Fails all four operations. Used by drivers that cannot generate text without side effects. */
export const makeUnsupportedTextGeneration = (detail: string): TextGeneration["Service"] => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail,
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};
