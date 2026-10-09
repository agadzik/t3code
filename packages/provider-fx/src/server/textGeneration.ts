import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

export const makeUnsupportedFxTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "fx does not provide application text generation yet.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};
