// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { type FxAdapterV2 } from "../../orchestration-v2/Adapters/FxAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { FxDriver } from "./FxDriver.ts";

const fixturesDir = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../Layers");
const SIGNED_IN_STATUS = NodeFS.readFileSync(NodePath.join(fixturesDir, "fx-status-signed-in.json"), "utf8");
const MODELS_JSON = NodeFS.readFileSync(NodePath.join(fixturesDir, "fx-models.json"), "utf8");

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fx-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("fx driver tests must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("FxDriver", (it) => {
  it.effect("disables text generation and feeds the probed default model to the adapter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-driver-" });
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "fx",
        source: [
          "const args = process.argv.slice(2);",
          'if (args[0] === "--version") {',
          '  process.stdout.write("fx 0.0.13\\n");',
          "  process.exit(0);",
          "}",
          'if (args[0] === "status" && args[1] === "--json") {',
          `  process.stdout.write(${JSON.stringify(SIGNED_IN_STATUS)});`,
          "  process.exit(0);",
          "}",
          'if (args[0] === "models" && args[1] === "--json") {',
          `  process.stdout.write(${JSON.stringify(MODELS_JSON)});`,
          "  process.exit(0);",
          "}",
          "process.exit(3);",
          "",
        ].join("\n"),
      });

      const instance = yield* FxDriver.create({
        instanceId: ProviderInstanceId.make("fx-probe"),
        displayName: "fx test",
        enabled: true,
        environment: [],
        config: { ...FxDriver.defaultConfig(), enabled: true, binaryPath },
      });

      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.supportsTextGeneration).toBe(false);
      expect(yield* (instance.orchestrationAdapter as FxAdapterV2).currentFxDefaultModel).toBe(
        "anthropic/claude-opus-5.5",
      );
    }).pipe(Effect.scoped),
  );
});
