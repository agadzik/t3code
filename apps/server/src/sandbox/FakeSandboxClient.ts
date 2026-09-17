/**
 * In-memory `SandboxClient` for tests. Records every call so tests assert the
 * exact create parameters, command sequence, and uploaded files; scripted
 * hooks decide what commands print and whether a create fails.
 *
 * Models just enough filesystem for workspace sync: a successful `git clone`
 * marks its target directory, `test -d` answers from that mark, a snapshot
 * captures the sandbox's directories, and a create from a snapshot restores
 * them. A clone into an existing directory fails the way real git does.
 */
import type { SandboxNetworkPolicy } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { SandboxCreateError } from "./Errors.ts";
import {
  SandboxClient,
  type SandboxClientShape,
  type SandboxCommandLog,
  type SandboxCommandResult,
  type SandboxCreateParams,
  type SandboxHandle,
  type SandboxListing,
  type SandboxRunCommandParams,
} from "./SandboxClient.ts";

export interface FakeSandboxCall {
  readonly sandbox: string;
  readonly op:
    | "run"
    | "runDetached"
    | "writeFiles"
    | "readFile"
    | "snapshot"
    | "stop"
    | "update"
    | "domain";
  readonly detail: string;
}

export interface FakeSandboxOptions {
  /** Output a detached command prints, by command. Defaults to nothing. */
  readonly detachedOutput?: (params: SandboxRunCommandParams) => ReadonlyArray<SandboxCommandLog>;
  /** Result of a blocking command. Defaults to exit 0 with empty output. */
  readonly runResult?: (params: SandboxRunCommandParams) => SandboxCommandResult;
  /** Decide per create attempt (0-based, counting failures) whether it fails. */
  readonly failCreate?: (
    params: SandboxCreateParams,
    attempt: number,
  ) => SandboxCreateError | undefined;
  /** Pre-existing sandboxes `list` and `get` see. */
  readonly existing?: ReadonlyArray<SandboxListing>;
}

export interface FakeSandboxClient {
  readonly client: SandboxClientShape;
  readonly layer: Layer.Layer<SandboxClient>;
  readonly creates: ReadonlyArray<SandboxCreateParams>;
  readonly calls: ReadonlyArray<FakeSandboxCall>;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly stopped: ReadonlySet<string>;
  readonly snapshots: ReadonlyArray<{
    readonly sandbox: string;
    readonly snapshotId: string;
    readonly expirationMs: number;
  }>;
  readonly policyUpdates: ReadonlyArray<{
    readonly sandbox: string;
    readonly networkPolicy: SandboxNetworkPolicy;
  }>;
}

export const makeFakeSandboxClient = (options: FakeSandboxOptions = {}): FakeSandboxClient => {
  const creates: SandboxCreateParams[] = [];
  const calls: FakeSandboxCall[] = [];
  const files = new Map<string, Uint8Array>();
  const stopped = new Set<string>();
  const snapshots: { sandbox: string; snapshotId: string; expirationMs: number }[] = [];
  const policyUpdates: { sandbox: string; networkPolicy: SandboxNetworkPolicy }[] = [];
  const existing = new Map((options.existing ?? []).map((listing) => [listing.name, listing]));
  const dirsBySandbox = new Map<string, Set<string>>();
  const dirsBySnapshot = new Map<string, Set<string>>();
  let commandCounter = 0;
  let createAttempts = 0;

  const record = (sandbox: string, op: FakeSandboxCall["op"], detail: string) => {
    calls.push({ sandbox, op, detail });
  };
  const commandText = (params: SandboxRunCommandParams) =>
    [params.cmd, ...(params.args ?? [])].join(" ");

  const handle = (name: string): SandboxHandle => ({
    name,
    run: (params) =>
      Effect.sync(() => {
        record(name, "run", commandText(params));
        const dirs = dirsBySandbox.get(name) ?? new Set<string>();
        if (params.cmd === "test" && params.args?.[0] === "-d") {
          const target = params.args[1] ?? "";
          const normalized = target.endsWith("/.git") ? target.slice(0, -"/.git".length) : target;
          return { exitCode: dirs.has(normalized) ? 0 : 1, stdout: "", stderr: "" };
        }
        if (params.cmd === "git" && params.args?.[0] === "clone") {
          const target = params.args[params.args.length - 1] ?? "";
          if (dirs.has(target)) {
            return {
              exitCode: 128,
              stdout: "",
              stderr: `fatal: destination path '${target}' already exists and is not an empty directory.`,
            };
          }
          dirs.add(target);
          dirsBySandbox.set(name, dirs);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return options.runResult?.(params) ?? { exitCode: 0, stdout: "", stderr: "" };
      }),
    runDetached: (params) =>
      Effect.sync(() => {
        record(name, "runDetached", commandText(params));
        commandCounter += 1;
        const output = options.detachedOutput?.(params) ?? [];
        return {
          cmdId: `cmd-${commandCounter}`,
          logs: Stream.fromIterable(output),
          wait: Effect.never,
          kill: Effect.void,
        };
      }),
    writeFiles: (uploads) =>
      Effect.sync(() => {
        for (const file of uploads) {
          files.set(file.path, file.content);
          record(name, "writeFiles", file.path);
        }
      }),
    readFile: (path) =>
      Effect.sync(() => {
        record(name, "readFile", path);
        return Option.fromNullishOr(files.get(path));
      }),
    snapshot: (params) =>
      Effect.sync(() => {
        const snapshotId = `snap-${name}-${snapshots.length + 1}`;
        snapshots.push({ sandbox: name, snapshotId, expirationMs: params.expirationMs });
        record(name, "snapshot", snapshotId);
        dirsBySnapshot.set(snapshotId, new Set(dirsBySandbox.get(name) ?? []));
        stopped.add(name);
        return snapshotId;
      }),
    stop: Effect.sync(() => {
      record(name, "stop", "");
      stopped.add(name);
    }),
    update: (params) =>
      Effect.sync(() => {
        policyUpdates.push({ sandbox: name, networkPolicy: params.networkPolicy });
        record(name, "update", "networkPolicy");
      }),
    domain: (port) =>
      Effect.sync(() => {
        record(name, "domain", String(port));
        return `https://${name}-${port}.sandbox.test`;
      }),
  });

  const client: SandboxClientShape = {
    create: (params) =>
      Effect.suspend(() => {
        const failure = options.failCreate?.(params, createAttempts);
        createAttempts += 1;
        if (failure !== undefined) return Effect.fail(failure);
        creates.push(params);
        if (params.source.kind === "snapshot") {
          const carried = dirsBySnapshot.get(params.source.snapshotId);
          if (carried) dirsBySandbox.set(params.name, new Set(carried));
        }
        return Effect.succeed(handle(params.name));
      }),
    get: (name) =>
      Effect.succeed(
        existing.has(name) || creates.some((c) => c.name === name)
          ? Option.some(handle(name))
          : Option.none(),
      ),
    list: (params) =>
      Effect.succeed(
        Array.from(existing.values()).filter(
          (listing) =>
            listing.name.startsWith(params.namePrefix) &&
            listing.tags[params.tag.key] === params.tag.value,
        ),
      ),
  };

  return {
    client,
    layer: Layer.succeed(SandboxClient, client),
    creates,
    calls,
    files,
    stopped,
    snapshots,
    policyUpdates,
  };
};
