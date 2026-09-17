/**
 * VercelSandboxClient - `SandboxClient` over the `@vercel/sandbox` SDK.
 *
 * Credentials are resolved on every call: the manual API token from the
 * secret store, team and project from `settings.vercelSandbox`. A settings
 * change therefore applies to the next sandbox without a restart.
 */
import { APIError, type Command, type Sandbox, Sandbox as VercelSandbox } from "@vercel/sandbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { VercelAuthService } from "../vercel/VercelAuthService.ts";
import {
  SandboxApiError,
  type SandboxCreateError,
  SandboxImageNotReadyError,
  SandboxNotConfiguredError,
  SandboxSnapshotGoneError,
} from "./Errors.ts";
import {
  SANDBOX_TAG_KEY,
  SandboxClient,
  type SandboxClientShape,
  type SandboxCommand,
  type SandboxCreateParams,
  type SandboxHandle,
  type SandboxListing,
} from "./SandboxClient.ts";

export interface SandboxCredentials {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const apiErrorCode = (error: APIError<unknown>): string | undefined => {
  const json = error.json;
  if (typeof json !== "object" || json === null) return undefined;
  const nested = (json as { error?: unknown }).error;
  const code =
    typeof nested === "object" && nested !== null
      ? (nested as { code?: unknown }).code
      : (json as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Map an SDK failure during `Sandbox.create` onto the typed errors callers
 * branch on. The API's exact codes are not published; `image_not_ready` is
 * the documented one for images still being built, and a missing snapshot
 * comes back as a 404 that names the snapshot.
 */
export const classifyCreateError = (
  params: SandboxCreateParams,
  cause: unknown,
): SandboxCreateError => {
  if (cause instanceof APIError) {
    const code = apiErrorCode(cause);
    const message = cause.message.toLowerCase();
    if (
      params.source.kind === "image" &&
      (code === "image_not_ready" ||
        (message.includes("image") &&
          (message.includes("not ready") || message.includes("not found"))))
    ) {
      return new SandboxImageNotReadyError({ image: params.source.image, detail: cause.message });
    }
    if (
      params.source.kind === "snapshot" &&
      (cause.response.status === 404 ||
        code === "snapshot_not_found" ||
        message.includes("snapshot"))
    ) {
      return new SandboxSnapshotGoneError({ snapshotId: params.source.snapshotId });
    }
  }
  return new SandboxApiError({ operation: "create", detail: errorText(cause), cause });
};

const apiCall = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SandboxApiError({ operation, detail: errorText(cause), cause }),
  });

const wrapCommand = (command: Command): SandboxCommand => ({
  cmdId: command.cmdId,
  logs: Stream.fromAsyncIterable(
    command.logs(),
    (cause) => new SandboxApiError({ operation: "command.logs", detail: errorText(cause), cause }),
  ),
  wait: apiCall("command.wait", async () => {
    const finished = await command.wait();
    return {
      exitCode: finished.exitCode,
      stdout: await finished.stdout(),
      stderr: await finished.stderr(),
    };
  }),
  kill: apiCall("command.kill", () => command.kill()),
});

export const wrapSandbox = (sandbox: Sandbox): SandboxHandle => ({
  name: sandbox.name,
  run: (params) =>
    apiCall(`run ${params.cmd}`, async () => {
      const finished = await sandbox.runCommand({
        cmd: params.cmd,
        ...(params.args !== undefined ? { args: [...params.args] } : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(params.env !== undefined ? { env: { ...params.env } } : {}),
      });
      return {
        exitCode: finished.exitCode,
        stdout: await finished.stdout(),
        stderr: await finished.stderr(),
      };
    }),
  runDetached: (params) =>
    apiCall(`runDetached ${params.cmd}`, () =>
      sandbox.runCommand({
        cmd: params.cmd,
        ...(params.args !== undefined ? { args: [...params.args] } : {}),
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(params.env !== undefined ? { env: { ...params.env } } : {}),
        detached: true,
      }),
    ).pipe(Effect.map(wrapCommand)),
  writeFiles: (files) =>
    apiCall("writeFiles", () =>
      sandbox.writeFiles(
        files.map((file) => ({
          path: file.path,
          content: file.content,
          ...(file.mode !== undefined ? { mode: file.mode } : {}),
        })),
      ),
    ),
  readFile: (path) =>
    apiCall("readFile", () => sandbox.readFileToBuffer({ path })).pipe(
      Effect.map((buffer) =>
        buffer === null ? Option.none() : Option.some(new Uint8Array(buffer)),
      ),
    ),
  snapshot: (params) =>
    apiCall("snapshot", () => sandbox.snapshot({ expiration: params.expirationMs })).pipe(
      Effect.map((snapshot) => snapshot.snapshotId),
    ),
  stop: apiCall("stop", () => sandbox.stop()).pipe(Effect.asVoid),
  update: (params) =>
    apiCall("update", () => sandbox.update({ networkPolicy: params.networkPolicy })),
  domain: (port) =>
    Effect.try({
      try: () => sandbox.domain(port),
      catch: (cause) =>
        new SandboxApiError({ operation: "domain", detail: errorText(cause), cause }),
    }),
});

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const vercelAuth = yield* VercelAuthService;

  const credentials = Effect.fn("VercelSandboxClient.credentials")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new SandboxApiError({ operation: "settings", detail: "Could not read settings.", cause }),
      ),
    );
    const { teamId, projectId } = current.vercelSandbox;
    if (teamId === "" || projectId === "") {
      return yield* new SandboxNotConfiguredError({
        detail: "Set the Vercel team id and project id under settings.vercelSandbox.",
      });
    }
    const token = yield* vercelAuth
      .getValidApiToken()
      .pipe(
        Effect.mapError(
          (cause) => new SandboxApiError({ operation: "credentials", detail: cause.detail, cause }),
        ),
      );
    if (Option.isNone(token)) {
      return yield* new SandboxNotConfiguredError({
        detail: "Paste a Vercel API token in Settings > Providers > Vercel to run sandboxes.",
      });
    }
    return { token: token.value, teamId, projectId } satisfies SandboxCredentials;
  });

  const create: SandboxClientShape["create"] = Effect.fn("VercelSandboxClient.create")(
    function* (params) {
      const creds = yield* credentials();
      const shared = {
        ...creds,
        name: params.name,
        timeout: params.timeoutMs,
        ports: [...params.ports],
        networkPolicy: params.networkPolicy,
        env: { ...params.env },
        tags: { ...params.tags },
        snapshotExpiration: params.snapshotExpirationMs,
        keepLastSnapshots: { count: params.keepLastSnapshots.count },
      };
      const sandbox = yield* Effect.tryPromise({
        try: () =>
          params.source.kind === "snapshot"
            ? VercelSandbox.create({
                ...shared,
                source: { type: "snapshot", snapshotId: params.source.snapshotId },
              })
            : VercelSandbox.create({ ...shared, image: params.source.image }),
        catch: (cause) => classifyCreateError(params, cause),
      });
      return wrapSandbox(sandbox);
    },
  );

  const get: SandboxClientShape["get"] = Effect.fn("VercelSandboxClient.get")(function* (name) {
    const creds = yield* credentials().pipe(
      Effect.catchTag(
        "SandboxNotConfiguredError",
        (error) => new SandboxApiError({ operation: "get", detail: error.detail }),
      ),
    );
    return yield* Effect.tryPromise({
      try: () => VercelSandbox.get({ ...creds, name, resume: false }),
      catch: (cause) => new SandboxApiError({ operation: "get", detail: errorText(cause), cause }),
    }).pipe(
      Effect.map((sandbox) => Option.some(wrapSandbox(sandbox))),
      Effect.catch((error) =>
        error.cause instanceof APIError && error.cause.response.status === 404
          ? Effect.succeed(Option.none())
          : Effect.fail(error),
      ),
    );
  });

  const list: SandboxClientShape["list"] = Effect.fn("VercelSandboxClient.list")(
    function* (params) {
      const creds = yield* credentials().pipe(
        Effect.catchTag(
          "SandboxNotConfiguredError",
          (error) => new SandboxApiError({ operation: "list", detail: error.detail }),
        ),
      );
      return yield* apiCall("list", async () => {
        const page = await VercelSandbox.list({
          ...creds,
          namePrefix: params.namePrefix,
          sortBy: "name",
          tags: { [SANDBOX_TAG_KEY]: params.tag.value },
        });
        const listings: SandboxListing[] = [];
        for await (const sandbox of page) {
          listings.push({
            name: sandbox.name,
            status: sandbox.status,
            tags: sandbox.tags ?? {},
            createdAt: sandbox.createdAt,
          });
        }
        return listings;
      });
    },
  );

  return SandboxClient.of({ create, get, list });
});

export const layer = Layer.effect(SandboxClient, make);
