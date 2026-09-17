/**
 * ProjectSandboxImages - one dependency-installed snapshot per project.
 *
 * The first sandbox for a project boots from the base image, clones the
 * workspace, runs the dependency install, and snapshots. Later threads boot
 * from that snapshot so `node_modules` is already there. The snapshot id is
 * persisted in `<stateDir>/sandbox-images.json`; a snapshot Vercel no longer
 * has is dropped through `invalidate` and rebuilt on the next request.
 */
import { ProjectId, sandboxNetworkPolicy } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import {
  SandboxApiError,
  type SandboxCommandFailedError,
  type SandboxCreateError,
} from "./Errors.ts";
import { SandboxClient, type SandboxHandle, type SandboxSource } from "./SandboxClient.ts";
import { runChecked, uploadWorkspace, WorkspaceBundler } from "./workspaceUpload.ts";

export const SANDBOX_IMAGES_FILE = "sandbox-images.json";
/** Image-build sandboxes are short-lived; the install must finish inside this. */
export const IMAGE_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
/** Measured from last use, so an active project's snapshot never expires under it. */
export const PROJECT_SNAPSHOT_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000;
export const IMAGE_SANDBOX_NAME_PREFIX = "t3-image-";

const ProjectSandboxImageRecord = Schema.Struct({
  snapshotId: Schema.String,
  baseImage: Schema.String,
  createdAt: Schema.String,
});
export type ProjectSandboxImageRecord = typeof ProjectSandboxImageRecord.Type;

const ProjectSandboxImageStore = Schema.Record(ProjectId, ProjectSandboxImageRecord);
type ProjectSandboxImageStore = typeof ProjectSandboxImageStore.Type;

const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectSandboxImageStore));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(ProjectSandboxImageStore));

/** Package managers the image build knows how to run, detected from lockfiles in the clone. */
export const PACKAGE_MANAGERS = ["pnpm", "bun", "yarn", "npm-ci", "npm", "none"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Shell probe run inside the clone; prints one `PackageManager` token. */
export const DETECT_PACKAGE_MANAGER_SCRIPT = [
  "if [ -f pnpm-lock.yaml ]; then echo pnpm;",
  "elif [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun;",
  "elif [ -f yarn.lock ]; then echo yarn;",
  "elif [ -f package-lock.json ]; then echo npm-ci;",
  "elif [ -f package.json ]; then echo npm;",
  "else echo none; fi",
].join(" ");

export const INSTALL_COMMANDS: Readonly<
  Record<
    Exclude<PackageManager, "none">,
    { readonly cmd: string; readonly args: ReadonlyArray<string> }
  >
> = {
  pnpm: { cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
  bun: { cmd: "bun", args: ["install", "--frozen-lockfile"] },
  yarn: { cmd: "yarn", args: ["install", "--frozen-lockfile"] },
  "npm-ci": { cmd: "npm", args: ["ci"] },
  npm: { cmd: "npm", args: ["install"] },
};

const isPackageManager = (value: string): value is PackageManager =>
  (PACKAGE_MANAGERS as ReadonlyArray<string>).includes(value);

export type ProjectImageError = SandboxCreateError | SandboxCommandFailedError | SandboxApiError;

export interface ProjectSandboxImagesShape {
  /** The source a thread sandbox for this project should boot from, building the snapshot if needed. */
  readonly resolveSource: (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly baseImage: string;
  }) => Effect.Effect<SandboxSource, ProjectImageError>;
  /** Forget a project's snapshot so the next resolve rebuilds it. */
  readonly invalidate: (projectId: ProjectId) => Effect.Effect<void, SandboxApiError>;
  readonly get: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectSandboxImageRecord | undefined, SandboxApiError>;
}

export class ProjectSandboxImages extends Context.Service<
  ProjectSandboxImages,
  ProjectSandboxImagesShape
>()("t3/sandbox/ProjectSandboxImages") {}

/** Clone the workspace into a fresh sandbox, install dependencies, snapshot it. */
export const buildProjectSnapshot = Effect.fn("buildProjectSnapshot")(function* (input: {
  readonly handle: SandboxHandle;
  readonly cwd: string;
  readonly bundle: Uint8Array;
}) {
  const workspaceDir = yield* uploadWorkspace({
    handle: input.handle,
    hostCwd: input.cwd,
    bundle: input.bundle,
  });
  const probe = yield* runChecked(input.handle, {
    cmd: "sh",
    args: ["-c", DETECT_PACKAGE_MANAGER_SCRIPT],
    cwd: workspaceDir,
  });
  const detected = probe.stdout.trim();
  const packageManager: PackageManager = isPackageManager(detected) ? detected : "none";
  if (packageManager !== "none") {
    const install = INSTALL_COMMANDS[packageManager];
    yield* runChecked(input.handle, { cmd: install.cmd, args: install.args, cwd: workspaceDir });
  }
  return yield* input.handle.snapshot({ expirationMs: PROJECT_SNAPSHOT_EXPIRATION_MS });
});

export const make = Effect.gen(function* () {
  const client = yield* SandboxClient;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundler = yield* WorkspaceBundler;
  const storePath = path.join(config.stateDir, SANDBOX_IMAGES_FILE);
  const storeLock = yield* Semaphore.make(1);
  const projectLocks = new Map<ProjectId, Semaphore.Semaphore>();

  const storeError = (detail: string, cause: unknown) =>
    new SandboxApiError({ operation: "sandbox-images store", detail, cause });

  const readStore = Effect.fn("ProjectSandboxImages.readStore")(function* () {
    const exists = yield* fs
      .exists(storePath)
      .pipe(Effect.mapError((cause) => storeError("Could not stat the store.", cause)));
    if (!exists) return {} as ProjectSandboxImageStore;
    const text = yield* fs
      .readFileString(storePath)
      .pipe(Effect.mapError((cause) => storeError("Could not read the store.", cause)));
    return yield* decodeStore(text).pipe(
      Effect.mapError((cause) => storeError("The store is malformed.", cause)),
    );
  });

  const writeStore = Effect.fn("ProjectSandboxImages.writeStore")(function* (
    store: ProjectSandboxImageStore,
  ) {
    const contents = yield* encodeStore(store).pipe(
      Effect.mapError((cause) => storeError("Could not encode the store.", cause)),
    );
    yield* writeFileStringAtomically({ filePath: storePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => storeError("Could not write the store.", cause)),
    );
  });

  const updateStore = (mutate: (store: ProjectSandboxImageStore) => ProjectSandboxImageStore) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readStore();
        yield* writeStore(mutate(current));
      }),
    );

  const withProjectLock = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let lock = projectLocks.get(projectId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        projectLocks.set(projectId, lock);
      }
      return lock.withPermits(1)(effect);
    });

  const get: ProjectSandboxImagesShape["get"] = (projectId) =>
    readStore().pipe(Effect.map((store) => store[projectId]));

  const invalidate: ProjectSandboxImagesShape["invalidate"] = (projectId) =>
    updateStore((store) => {
      const { [projectId]: _dropped, ...rest } = store;
      return rest;
    });

  const build = Effect.fn("ProjectSandboxImages.build")(function* (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly baseImage: string;
  }) {
    const bundle = yield* bundler.bundle(input.cwd);
    const handle = yield* client.create({
      name: `${IMAGE_SANDBOX_NAME_PREFIX}${input.projectId}`,
      source: { kind: "image", image: input.baseImage },
      timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
      ports: [],
      networkPolicy: sandboxNetworkPolicy(undefined),
      env: {},
      tags: { t3code: "image", projectId: input.projectId },
      snapshotExpirationMs: PROJECT_SNAPSHOT_EXPIRATION_MS,
      keepLastSnapshots: { count: 1 },
    });
    // `snapshot` shuts the sandbox down on success; on failure stop it so a
    // half-built VM does not run out its 30 minute timeout billing the user.
    const snapshotId = yield* buildProjectSnapshot({ handle, cwd: input.cwd, bundle }).pipe(
      Effect.onError(() => handle.stop.pipe(Effect.ignore)),
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* updateStore((store) => ({
      ...store,
      [input.projectId]: { snapshotId, baseImage: input.baseImage, createdAt },
    }));
    return snapshotId;
  });

  const resolveSource: ProjectSandboxImagesShape["resolveSource"] = (input) =>
    withProjectLock(
      input.projectId,
      Effect.gen(function* () {
        const existing = yield* get(input.projectId);
        if (existing !== undefined && existing.baseImage === input.baseImage) {
          return { kind: "snapshot", snapshotId: existing.snapshotId } satisfies SandboxSource;
        }
        const snapshotId = yield* build(input);
        return { kind: "snapshot", snapshotId } satisfies SandboxSource;
      }),
    );

  return ProjectSandboxImages.of({ resolveSource, invalidate, get });
});

export const layer = Layer.effect(ProjectSandboxImages, make);
