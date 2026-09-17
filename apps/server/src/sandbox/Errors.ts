import * as Schema from "effect/Schema";

/** Sandbox execution is on but the team, project, or API token is missing. */
export class SandboxNotConfiguredError extends Schema.TaggedError<SandboxNotConfiguredError>()(
  "SandboxNotConfiguredError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The VCR image the sandbox should boot from has not been built or pushed yet. */
export class SandboxImageNotReadyError extends Schema.TaggedError<SandboxImageNotReadyError>()(
  "SandboxImageNotReadyError",
  { image: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Sandbox image '${this.image}' is not ready: ${this.detail} Build and push it with \`node scripts/build-sandbox-image.ts\`.`;
  }
}

/** A persisted project snapshot no longer exists on Vercel (expired or deleted). */
export class SandboxSnapshotGoneError extends Schema.TaggedError<SandboxSnapshotGoneError>()(
  "SandboxSnapshotGoneError",
  { snapshotId: Schema.String },
) {
  override get message(): string {
    return `Sandbox snapshot '${this.snapshotId}' is gone.`;
  }
}

/** Any other Vercel Sandbox API or transport failure. */
export class SandboxApiError extends Schema.TaggedError<SandboxApiError>()("SandboxApiError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

/** A command the sandbox flow depends on (git clone, dependency install) exited non-zero. */
export class SandboxCommandFailedError extends Schema.TaggedError<SandboxCommandFailedError>()(
  "SandboxCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    return `'${this.command}' exited with code ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

export type SandboxCreateError =
  | SandboxApiError
  | SandboxImageNotReadyError
  | SandboxSnapshotGoneError
  | SandboxNotConfiguredError;
