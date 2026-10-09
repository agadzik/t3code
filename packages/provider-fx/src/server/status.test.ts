// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { FxSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  buildFxModels,
  checkFxProviderStatus,
  fxLoginToProviderAuth,
  parseFxModelsJson,
  parseFxStatusJson,
} from "./status.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const fixturesDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SIGNED_IN_STATUS = NodeFS.readFileSync(
  NodePath.join(fixturesDir, "fx-status-signed-in.json"),
  "utf8",
);
const SIGNED_OUT_STATUS = NodeFS.readFileSync(
  NodePath.join(fixturesDir, "fx-status-signed-out.json"),
  "utf8",
);
const MODELS_JSON = NodeFS.readFileSync(NodePath.join(fixturesDir, "fx-models.json"), "utf8");

describe("parseFxStatusJson", () => {
  it("maps a signed-in capture to SignedIn and the default model", () => {
    expect(parseFxStatusJson(SIGNED_IN_STATUS)).toEqual({
      login: { _tag: "SignedIn", method: "fx login" },
      defaultModel: "anthropic/claude-opus-5.5",
    });
  });

  it("maps a signed-out capture to SignedOut with auth_help", () => {
    expect(parseFxStatusJson(SIGNED_OUT_STATUS)).toEqual({
      login: {
        _tag: "SignedOut",
        help: "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
      },
      defaultModel: "spacexai/grok-4.7",
    });
  });

  it("falls back when signed-out status omits auth_help", () => {
    expect(parseFxStatusJson(JSON.stringify({ auth: "missing" }))).toEqual({
      login: { _tag: "SignedOut", help: "Run `fx login` to sign in." },
      defaultModel: undefined,
    });
  });

  it("maps undecodable output to Unknown", () => {
    expect(parseFxStatusJson("not json")).toEqual({
      login: { _tag: "Unknown" },
      defaultModel: undefined,
    });
    expect(parseFxStatusJson("{}")).toEqual({
      login: { _tag: "Unknown" },
      defaultModel: undefined,
    });
  });
});

describe("fxLoginToProviderAuth", () => {
  it("maps each login tag onto provider auth", () => {
    expect(fxLoginToProviderAuth({ _tag: "SignedIn", method: "fx login" })).toEqual({
      status: "authenticated",
      label: "fx login",
    });
    expect(fxLoginToProviderAuth({ _tag: "SignedOut", help: "run fx login" })).toEqual({
      status: "unauthenticated",
    });
    expect(fxLoginToProviderAuth({ _tag: "Unknown" })).toEqual({ status: "unknown" });
  });
});

describe("parseFxModelsJson", () => {
  it("reads catalog ids from a capture", () => {
    expect(parseFxModelsJson(MODELS_JSON)).toEqual([
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-opus-5.5",
      "openai/gpt-5.6-sol",
      "spacexai/grok-4.7",
    ]);
  });

  it("returns an empty list on decode failure", () => {
    expect(parseFxModelsJson("not json")).toEqual([]);
    expect(parseFxModelsJson("{}")).toEqual([]);
  });
});

describe("buildFxModels", () => {
  it("puts Default first, then catalog ids, then custom models", () => {
    const models = buildFxModels({
      ids: ["anthropic/claude-opus-5.5", "openai/gpt-5.6-sol"],
      defaultModel: "anthropic/claude-opus-5.5",
      customModels: ["my-fx-model"],
    });
    expect(
      models.map((model) => [model.slug, model.name, model.isCustom, model.isDefault ?? false]),
    ).toEqual([
      ["default", "Default (anthropic/claude-opus-5.5)", false, true],
      ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5", false, false],
      ["openai/gpt-5.6-sol", "openai/gpt-5.6-sol", false, false],
      ["my-fx-model", "my-fx-model", true, false],
    ]);
    expect(models[0]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
      "effort",
    ]);
  });
});

it.layer(NodeServices.layer)("checkFxProviderStatus", (it) => {
  const writeFakeFxCli = (input: {
    readonly argvLogPath?: string;
    readonly versionExit?: number;
    readonly statusJson?: string;
    readonly modelsJson?: string;
    readonly modelsExit?: number;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "fx",
        source: [
          'import { appendFileSync } from "node:fs";',
          "const args = process.argv.slice(2);",
          ...(input.argvLogPath === undefined
            ? []
            : [`appendFileSync(${JSON.stringify(input.argvLogPath)}, args.join(" ") + "\\n");`]),
          'if (args[0] === "--version") {',
          '  process.stdout.write("fx 0.0.13\\n");',
          `  process.exit(${input.versionExit ?? 0});`,
          "}",
          'if (args[0] === "status" && args[1] === "--json") {',
          `  process.stdout.write(${JSON.stringify(input.statusJson ?? SIGNED_IN_STATUS)});`,
          "  process.exit(0);",
          "}",
          'if (args[0] === "models" && args[1] === "--json") {',
          `  process.stdout.write(${JSON.stringify(input.modelsJson ?? MODELS_JSON)});`,
          `  process.exit(${input.modelsExit ?? 0});`,
          "}",
          "process.exit(3);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports a non-zero version exit as installed but failed after one spawn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-version-fail-" });
      const argvLogPath = NodePath.join(dir, "argv.log");
      const probe = yield* checkFxProviderStatus(
        decodeFxSettings({
          enabled: true,
          binaryPath: writeFakeCli({
            directory: dir,
            name: "fx",
            source: [
              'import { appendFileSync } from "node:fs";',
              `appendFileSync(${JSON.stringify(argvLogPath)}, process.argv.slice(2).join(" ") + "\\n");`,
              "process.exit(1);",
              "",
            ].join("\n"),
          }),
        }),
      );
      expect(probe.draft.installed).toBe(true);
      expect(probe.draft.status).toBe("error");
      expect(probe.draft.message).toBe("fx is installed but failed to run.");
      expect(probe.defaultModel).toBeUndefined();
      expect(NodeFS.readFileSync(argvLogPath, "utf8")).toBe("--version\n");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-fx-missing-" });
      const probe = yield* checkFxProviderStatus(
        decodeFxSettings({
          enabled: true,
          binaryPath: NodePath.join(dir, "no-such-fx"),
        }),
      );
      expect(probe.draft.installed).toBe(false);
      expect(probe.draft.status).toBe("error");
      expect(probe.draft.message).toBe("fx is not installed or not on PATH.");
      expect(probe.defaultModel).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("maps signed-in status onto authenticated ready", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const fxPath = yield* writeFakeFxCli({});
          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );
      expect(probe.defaultModel).toBe("anthropic/claude-opus-5.5");
      expect(probe.draft.status).toBe("ready");
      expect(probe.draft.version).toBe("0.0.13");
      expect(probe.draft.auth).toEqual({ status: "authenticated", label: "fx login" });
      expect(probe.draft.models.map((model) => model.slug)).toEqual([
        "default",
        "anthropic/claude-sonnet-5.5",
        "anthropic/claude-opus-5.5",
        "openai/gpt-5.6-sol",
        "spacexai/grok-4.7",
      ]);
      expect(probe.draft.models[0]?.name).toBe("Default (anthropic/claude-opus-5.5)");
    }),
  );

  it.effect("maps signed-out status onto error with auth_help", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const fxPath = yield* writeFakeFxCli({ statusJson: SIGNED_OUT_STATUS });
          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );
      expect(probe.draft.status).toBe("error");
      expect(probe.draft.auth.status).toBe("unauthenticated");
      expect(probe.draft.message).toBe(
        "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.",
      );
    }),
  );

  it.effect("maps undecodable status onto unknown with a warning", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const fxPath = yield* writeFakeFxCli({ statusJson: "not-json" });
          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          );
        }),
      );
      expect(probe.draft.status).toBe("warning");
      expect(probe.draft.auth.status).toBe("unknown");
    }),
  );

  it.effect("keeps Default plus custom models when models listing fails", () =>
    Effect.gen(function* () {
      const probe = yield* Effect.scoped(
        Effect.gen(function* () {
          const fxPath = yield* writeFakeFxCli({ modelsExit: 3 });
          return yield* checkFxProviderStatus(
            decodeFxSettings({ enabled: true, binaryPath: fxPath, customModels: ["my-fx-model"] }),
          );
        }),
      );
      expect(probe.draft.status).toBe("warning");
      expect(probe.draft.models.map((model) => model.slug)).toEqual(["default", "my-fx-model"]);
    }),
  );
});
