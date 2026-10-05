import {
  type CustomModelSetting,
  type FxSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  FX_DEFAULT_MODEL_SLUG,
  FX_EFFORT_OPTION_DESCRIPTOR,
  FX_SUPPORTED_RUNTIME_MODES,
} from "../acp/FxAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

export const FX_PRESENTATION = {
  displayName: "fx",
  showInteractionModeToggle: false,
  supportedRuntimeModes: FX_SUPPORTED_RUNTIME_MODES,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const FX_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [FX_EFFORT_OPTION_DESCRIPTOR],
});

export type FxLogin =
  | { readonly _tag: "SignedIn"; readonly method: string }
  | { readonly _tag: "SignedOut"; readonly help: string }
  | { readonly _tag: "Unknown" };

export interface FxStatus {
  readonly login: FxLogin;
  readonly defaultModel: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyUnknownString(value: unknown): string | undefined {
  return typeof value === "string" ? nonEmptyTrimmed(value) : undefined;
}

export interface FxProviderStatus {
  readonly draft: ServerProviderDraft;
  readonly defaultModel: string | undefined;
}

const SIGNED_OUT_HELP = "Run `fx login` to sign in.";

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
  const defaultModel = nonEmptyUnknownString(parsed.model);
  const auth = nonEmptyUnknownString(parsed.auth);
  if (auth === "missing") {
    return {
      login: {
        _tag: "SignedOut",
        help: nonEmptyUnknownString(parsed.auth_help) ?? SIGNED_OUT_HELP,
      },
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
    const slug = nonEmptyUnknownString(id);
    return slug === undefined ? [] : [slug];
  });
}

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

export function buildInitialFxProviderSnapshot(
  settings: FxSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!settings.enabled) {
      return fxDisabledDraft(settings, checkedAt);
    }
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: buildFxModels({
        ids: [],
        defaultModel: undefined,
        customModels: settings.customModels,
      }),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking fx CLI availability...",
      },
    });
  });
}

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

function fxVersionProbeDraft(
  settings: FxSettings,
  checkedAt: string,
  probe: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly message: string;
  },
): ServerProviderDraft {
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
      installed: probe.installed,
      version: probe.version,
      status: "error",
      auth: { status: "unknown" },
      message: probe.message,
    },
  });
}

function fxProbe(
  draft: ServerProviderDraft,
  defaultModel: string | undefined = undefined,
): FxProviderStatus {
  return { draft, defaultModel };
}

export const checkFxProviderStatus = Effect.fn("checkFxProviderStatus")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<FxProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!settings.enabled) {
    return fxProbe(fxDisabledDraft(settings, checkedAt));
  }

  const versionResult = yield* runFxCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("fx CLI health check failed.", { errorTag: error._tag });
    const missing = isCommandMissingCause(error);
    return fxProbe(
      fxVersionProbeDraft(settings, checkedAt, {
        installed: !missing,
        version: null,
        message: missing
          ? "fx is not installed or not on PATH."
          : "Failed to execute fx CLI health check.",
      }),
    );
  }
  if (Option.isNone(versionResult.success)) {
    yield* Effect.logWarning("fx CLI version probe timed out.");
    return fxProbe(
      fxVersionProbeDraft(settings, checkedAt, {
        installed: true,
        version: null,
        message: "fx is installed but timed out while running `fx --version`.",
      }),
    );
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("fx CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return fxProbe(
      fxVersionProbeDraft(settings, checkedAt, {
        installed: true,
        version,
        message: "fx is installed but failed to run.",
      }),
    );
  }

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
    return fxProbe(
      buildServerProvider({
        presentation: FX_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: status.login.help,
        },
      }),
      status.defaultModel,
    );
  }

  if (status.login._tag === "Unknown") {
    return fxProbe(
      buildServerProvider({
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
      }),
      status.defaultModel,
    );
  }

  return fxProbe(
    buildServerProvider({
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
    }),
    status.defaultModel,
  );
});

export const enrichFxSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("fx version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
