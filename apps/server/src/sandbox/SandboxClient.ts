/**
 * SandboxClient - the slice of the Vercel Sandbox API T3 uses, as Effects.
 *
 * `VercelSandboxClient.ts` implements it over `@vercel/sandbox`;
 * `FakeSandboxClient.ts` implements it in memory for tests. Everything above
 * this interface (project images, runner backend, reaper) is provider-agnostic
 * and never imports the SDK.
 */
import type { SandboxNetworkPolicy } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { SandboxApiError, SandboxCreateError } from "./Errors.ts";

export const SANDBOX_TAG_KEY = "t3code";

/** What a new sandbox boots from: a VCR image or a snapshot taken from one. */
export type SandboxSource =
  | { readonly kind: "image"; readonly image: string }
  | { readonly kind: "snapshot"; readonly snapshotId: string };

export interface SandboxCreateParams {
  readonly name: string;
  readonly source: SandboxSource;
  readonly timeoutMs: number;
  readonly ports: ReadonlyArray<number>;
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly env: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly snapshotExpirationMs: number;
  readonly keepLastSnapshots: { readonly count: number };
}

export interface SandboxRunCommandParams {
  readonly cmd: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface SandboxCommandLog {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A detached process inside the sandbox. */
export interface SandboxCommand {
  readonly cmdId: string;
  readonly logs: Stream.Stream<SandboxCommandLog, SandboxApiError>;
  readonly wait: Effect.Effect<SandboxCommandResult, SandboxApiError>;
  readonly kill: Effect.Effect<void, SandboxApiError>;
}

export interface SandboxHandle {
  readonly name: string;
  readonly run: (
    params: SandboxRunCommandParams,
  ) => Effect.Effect<SandboxCommandResult, SandboxApiError>;
  readonly runDetached: (
    params: SandboxRunCommandParams,
  ) => Effect.Effect<SandboxCommand, SandboxApiError>;
  readonly writeFiles: (
    files: ReadonlyArray<{
      readonly path: string;
      readonly content: Uint8Array;
      readonly mode?: number;
    }>,
  ) => Effect.Effect<void, SandboxApiError>;
  readonly readFile: (path: string) => Effect.Effect<Option.Option<Uint8Array>, SandboxApiError>;
  /** Captures the filesystem and shuts the sandbox down; the handle is dead afterwards. */
  readonly snapshot: (params: {
    readonly expirationMs: number;
  }) => Effect.Effect<string, SandboxApiError>;
  readonly stop: Effect.Effect<void, SandboxApiError>;
  readonly update: (params: {
    readonly networkPolicy: SandboxNetworkPolicy;
  }) => Effect.Effect<void, SandboxApiError>;
  /** Public URL for a port declared in `ports` at creation. */
  readonly domain: (port: number) => Effect.Effect<string, SandboxApiError>;
}

export interface SandboxListing {
  readonly name: string;
  readonly status:
    | "pending"
    | "running"
    | "stopping"
    | "stopped"
    | "failed"
    | "aborted"
    | "snapshotting";
  readonly tags: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

export interface SandboxClientShape {
  readonly create: (
    params: SandboxCreateParams,
  ) => Effect.Effect<SandboxHandle, SandboxCreateError>;
  /** Attach to an existing sandbox without resuming a stopped one. */
  readonly get: (name: string) => Effect.Effect<Option.Option<SandboxHandle>, SandboxApiError>;
  /** Vercel filters by exactly one tag; T3 always tags its sandboxes under `t3code`. */
  readonly list: (params: {
    readonly namePrefix: string;
    readonly tag: { readonly key: typeof SANDBOX_TAG_KEY; readonly value: string };
  }) => Effect.Effect<ReadonlyArray<SandboxListing>, SandboxApiError>;
}

export class SandboxClient extends Context.Service<SandboxClient, SandboxClientShape>()(
  "t3/sandbox/SandboxClient",
) {}
