import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkFxProviderStatus, FxModelCatalogError, fxModelsFromCatalog } from "./FxProvider.ts";

describe("FxProvider status", () => {
  it.effect("reports unauthenticated without an API key and never calls the catalog", () =>
    Effect.gen(function* () {
      let calls = 0;
      const snapshot = yield* checkFxProviderStatus(
        { enabled: true, apiKey: undefined, model: "openai/gpt-5" },
        () =>
          Effect.sync(() => {
            calls += 1;
            return [];
          }),
      );
      assert.equal(calls, 0);
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message, "FX_API_KEY");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["openai/gpt-5"],
      );
    }),
  );

  it.effect("lists the gateway catalog as models when the key works", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkFxProviderStatus(
        { enabled: true, apiKey: "k", model: "anthropic/claude-sonnet-4" },
        (apiKey) =>
          Effect.succeed(apiKey === "k" ? ["openai/gpt-5", "anthropic/claude-sonnet-4"] : []),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => [model.slug, model.isDefault ?? false]),
        [
          ["anthropic/claude-sonnet-4", true],
          ["openai/gpt-5", false],
        ],
      );
    }),
  );

  it.effect("surfaces a catalog failure as an error with its detail", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkFxProviderStatus(
        { enabled: true, apiKey: "k", model: undefined },
        () => Effect.fail(new FxModelCatalogError({ detail: "HTTP 401" })),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.equal(snapshot.message, "Could not reach the AI Gateway model catalog: HTTP 401");
      assert.deepEqual(snapshot.models, []);
    }),
  );

  it.effect("marks a disabled instance without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkFxProviderStatus(
        { enabled: false, apiKey: "k", model: undefined },
        () => Effect.die("must not probe"),
      );
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.enabled, false);
    }),
  );

  it("dedupes the configured model against the catalog", () => {
    assert.deepEqual(
      fxModelsFromCatalog(["b", "a"], "a").map((model) => model.slug),
      ["a", "b"],
    );
  });
});
