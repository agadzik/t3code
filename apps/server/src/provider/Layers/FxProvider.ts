import {
  type CustomModelSetting,
  type FxSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  FX_DEFAULT_MODEL_SLUG,
  FX_EFFORT_OPTION_DESCRIPTOR,
  FX_SUPPORTED_RUNTIME_MODES,
} from "../acp/FxAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const FX_PRESENTATION = {
  displayName: "fx",
  showInteractionModeToggle: false,
  supportedRuntimeModes: FX_SUPPORTED_RUNTIME_MODES,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const FX_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [FX_EFFORT_OPTION_DESCRIPTOR],
});

/**
 * Domain view of `fx status --json`. Observed shapes:
 *   signed in:  { auth: "fx login", auth_refreshable: true, model: "..." }
 *   signed out: { auth: "missing", auth_refreshable: false, auth_help: "..." }
 * The wire shape stays in this file. `team` and the MCP inventory are never read.
 */
export type FxLogin =
  | { readonly _tag: "SignedIn"; readonly method: string }
  | { readonly _tag: "SignedOut"; readonly help: string }
  | { readonly _tag: "Unknown" };

export interface FxStatus {
  readonly login: FxLogin;
  readonly defaultModel: string | undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `auth === "missing"` -> SignedOut; other non-empty `auth` -> SignedIn; undecodable -> Unknown. */
export function parseFxStatusJson(stdout: string): FxStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { login: { _tag: "Unknown" }, defaultModel: undefined };
  }
  if (!isRecord(parsed)) {
    return { login: { _tag: "Unknown" }, defaultModel: undefined };
  }
  const defaultModel = nonEmptyString(parsed.model);
  const auth = nonEmptyString(parsed.auth);
  if (parsed.auth === "missing") {
    return {
      login: { _tag: "SignedOut", help: typeof parsed.auth_help === "string" ? parsed.auth_help : "" },
      defaultModel,
    };
  }
  if (auth !== undefined) {
    return { login: { _tag: "SignedIn", method: auth }, defaultModel };
  }
  return { login: { _tag: "Unknown" }, defaultModel };
}

export function fxLoginToProviderAuth(login: FxLogin): ServerProviderAuth {
  switch (login._tag) {
    case "SignedIn":
      return { status: "authenticated", label: login.method };
    case "SignedOut":
      return { status: "unauthenticated" };
    case "Unknown":
      return { status: "unknown" };
  }
}

/** `fx models --json` -> `ids`. Empty on decode failure. */
export function parseFxModelsJson(stdout: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.ids)) {
    return [];
  }
  return parsed.ids.flatMap((id) => {
    const slug = nonEmptyString(id);
    return slug === undefined ? [] : [slug];
  });
}

/** "Default (<fx model>)" first, then catalog ids, each carrying FX_EFFORT_OPTION_DESCRIPTOR; custom models last. */
export function buildFxModels(input: {
  readonly ids: ReadonlyArray<string>;
  readonly defaultModel: string | undefined;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}): ReadonlyArray<ServerProviderModel> {
  const defaultEntry: ServerProviderModel = {
    slug: FX_DEFAULT_MODEL_SLUG,
    name: input.defaultModel ? `Default (${input.defaultModel})` : "Default",
    isCustom: false,
    isDefault: true,
    capabilities: FX_MODEL_CAPABILITIES,
  };
  const seen = new Set<string>([FX_DEFAULT_MODEL_SLUG]);
  const catalog: Array<ServerProviderModel> = [];
  for (const id of input.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    catalog.push({
      slug: id,
      name: id,
      isCustom: false,
      capabilities: FX_MODEL_CAPABILITIES,
    });
  }
  return providerModelsFromSettings([defaultEntry, ...catalog], input.customModels, FX_MODEL_CAPABILITIES);
}

const runFxCliCommand = (
  settings: FxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "fx";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function fxDisabledDraft(
  settings: FxSettings,
  checkedAt: string,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: FX_PRESENTATION,
    enabled: false,
    checkedAt,
    models: buildFxModels({
      ids: [],
      defaultModel: undefined,
      customModels: settings.customModels,
    }),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "fx is disabled in T3 Code settings.",
    },
  });
}

function fxNotInstalledDraft(settings: FxSettings, checkedAt: string): ServerProviderDraft {
  return buildServerProvider({
    presentation: FX_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: buildFxModels({
      ids: [],
      defaultModel: undefined,
      customModels: settings.customModels,
    }),
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "fx is not installed",
    },
  });
}

/**
 * Three read-only CLI calls, no ACP process: `fx --version`, `fx status --json`, `fx models --json`.
 * Never opens a session.
 */
export const checkFxProviderStatus = Effect.fn("checkFxProviderStatus")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!settings.enabled) {
    return fxDisabledDraft(settings, checkedAt);
  }

  const versionResult = yield* runFxCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (
    Result.isFailure(versionResult) ||
    Option.isNone(versionResult.success) ||
    versionResult.success.value.code !== 0
  ) {
    if (Result.isFailure(versionResult)) {
      yield* Effect.logWarning("fx CLI health check failed.", { errorTag: versionResult.failure._tag });
    }
    return fxNotInstalledDraft(settings, checkedAt);
  }

  const version = parseGenericCliVersion(
    `${versionResult.success.value.stdout}\n${versionResult.success.value.stderr}`,
  );

  const statusResult = yield* runFxCliCommand(settings, ["status", "--json"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const statusOutput =
    Result.isSuccess(statusResult) &&
    Option.isSome(statusResult.success) &&
    statusResult.success.value.code === 0
      ? statusResult.success.value
      : undefined;
  const status = statusOutput
    ? parseFxStatusJson(statusOutput.stdout)
    : { login: { _tag: "Unknown" } as const, defaultModel: undefined };

  const modelsResult = yield* runFxCliCommand(settings, ["models", "--json"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const ids = modelsOutput ? parseFxModelsJson(modelsOutput.stdout) : [];
  const modelsFailed = modelsOutput === undefined;
  if (modelsFailed) {
    yield* Effect.logWarning("fx model listing failed or timed out.");
  }

  const models = buildFxModels({
    ids,
    defaultModel: status.defaultModel,
    customModels: settings.customModels,
  });
  const auth = fxLoginToProviderAuth(status.login);

  if (status.login._tag === "SignedOut") {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        ...(status.login.help ? { message: status.login.help } : {}),
      },
    });
  }

  if (status.login._tag === "Unknown") {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth,
        message: "fx is installed but login state could not be determined.",
      },
    });
  }

  return buildServerProvider({
    presentation: FX_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: modelsFailed ? "warning" : "ready",
      auth,
      ...(modelsFailed
        ? { message: "fx is installed but model listing failed. Model options may be incomplete." }
        : {}),
    },
  });
});
