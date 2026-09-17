import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  SANDBOX_INJECTED_API_KEY,
  sandboxNetworkPolicy,
  ThreadId,
} from "@t3tools/contracts";
import { APIError } from "@vercel/sandbox";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import type { connectRunnerSocket, FxRunnerLink } from "../provider/Layers/FxRunnerLink.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VercelAuth from "../vercel/VercelAuthService.ts";
import { SandboxImageNotReadyError, SandboxSnapshotGoneError } from "./Errors.ts";
import { type FakeSandboxOptions, makeFakeSandboxClient } from "./FakeSandboxClient.ts";
import * as ProjectSandboxImages from "./ProjectSandboxImages.ts";
import type { SandboxListing } from "./SandboxClient.ts";
import * as SandboxRunnerBackend from "./SandboxRunnerBackend.ts";
import { classifyCreateError } from "./VercelSandboxClient.ts";
import { sandboxWorkspaceDir, WorkspaceBundler } from "./workspaceUpload.ts";

const projectId = ProjectId.make("proj-1");
const threadId = ThreadId.make("Thread-1");
const bundleBytes = new Uint8Array([0x67, 0x69, 0x74]);
const listeningLine = '{"type":"listening","port":8080}\n';

type ConnectInput = Parameters<typeof connectRunnerSocket>[0];

let layerSeq = 0;

/** Every dependency the backend has, with the Vercel API replaced by the fake and git by canned bytes. */
const makeHarness = (
  fakeOptions: FakeSandboxOptions = {},
  settings: {
    readonly enabled?: boolean;
    readonly teamId?: string;
    readonly projectId?: string;
  } = {},
) => {
  layerSeq += 1;
  const fake = makeFakeSandboxClient({
    detachedOutput: () => [{ stream: "stdout", data: listeningLine }],
    runResult: (params) =>
      params.cmd === "sh"
        ? { exitCode: 0, stdout: "pnpm\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    ...fakeOptions,
  });
  const connects: ConnectInput[] = [];
  const connect: typeof connectRunnerSocket = (input) =>
    Effect.sync(() => {
      connects.push(input);
      return {
        placement: input.placement,
        send: () => Effect.void,
        frames: Stream.empty,
        close: Effect.void,
      } satisfies FxRunnerLink;
    });

  const configLayer = Layer.fresh(
    ServerConfig.layerTest(process.cwd(), { prefix: `t3-sandbox-test-${layerSeq}-` }),
  );
  const secretsLayer = ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer));
  const vercelAuthLayer = VercelAuth.layer.pipe(Layer.provide(secretsLayer));
  const settingsLayer = ServerSettings.layerTest({
    vercelSandbox: {
      enabled: settings.enabled ?? true,
      teamId: settings.teamId ?? "team_1",
      projectId: settings.projectId ?? "prj_1",
    },
  });
  const bundlerLayer = Layer.succeed(WorkspaceBundler, {
    bundle: () => Effect.succeed(bundleBytes),
  });
  const imagesLayer = ProjectSandboxImages.layer.pipe(
    Layer.provide(fake.layer),
    Layer.provide(bundlerLayer),
    Layer.provideMerge(configLayer),
  );
  const backendLayer = SandboxRunnerBackend.makeLayer({ connect }).pipe(
    Layer.provideMerge(imagesLayer),
    Layer.provide(fake.layer),
    Layer.provide(settingsLayer),
    Layer.provideMerge(vercelAuthLayer),
    Layer.provide(bundlerLayer),
  );
  return {
    fake,
    connects,
    layer: backendLayer.pipe(Layer.provideMerge(NodeServices.layer)),
  };
};

const withGatewayKey = Effect.gen(function* () {
  const auth = yield* VercelAuth.VercelAuthService;
  yield* auth.setGatewayKey("gw-key-1");
});

const launchInScope = (input: { readonly threadId: ThreadId; readonly projectId?: ProjectId }) =>
  Effect.gen(function* () {
    const backend = yield* SandboxRunnerBackend.SandboxRunnerBackend;
    const scope = yield* Scope.make("sequential");
    const link = yield* backend.launcher
      .launch({ threadId: input.threadId, cwd: "/Users/dev/My App", projectId: input.projectId })
      .pipe(Effect.provideService(Scope.Scope, scope));
    return { link, scope };
  });

describe("SandboxRunnerBackend", () => {
  it.effect("builds the project image once, then boots thread sandboxes from its snapshot", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        yield* withGatewayKey;
        const first = yield* launchInScope({ threadId, projectId });

        const [imageBuild, threadSandbox] = harness.fake.creates;
        assert.deepEqual(imageBuild, {
          name: "t3-image-proj-1",
          source: { kind: "image", image: "t3code-agent:latest" },
          timeoutMs: 30 * 60 * 1000,
          ports: [],
          networkPolicy: sandboxNetworkPolicy(undefined),
          env: {},
          tags: { t3code: "image", projectId: "proj-1" },
          snapshotExpirationMs: 14 * 24 * 60 * 60 * 1000,
          keepLastSnapshots: { count: 1 },
        });
        assert.deepEqual(
          harness.fake.calls
            .filter((call) => call.sandbox === "t3-image-proj-1")
            .map((call) => `${call.op}:${call.detail}`),
          [
            "writeFiles:/vercel/sandbox/.t3/workspace.bundle",
            "run:git clone --quiet /vercel/sandbox/.t3/workspace.bundle /vercel/sandbox/My-App",
            "run:rm -f /vercel/sandbox/.t3/workspace.bundle",
            `run:sh -c ${ProjectSandboxImages.DETECT_PACKAGE_MANAGER_SCRIPT}`,
            "run:pnpm install --frozen-lockfile",
            "snapshot:snap-t3-image-proj-1-1",
          ],
        );
        assert.deepEqual(harness.fake.snapshots, [
          {
            sandbox: "t3-image-proj-1",
            snapshotId: "snap-t3-image-proj-1-1",
            expirationMs: 14 * 24 * 60 * 60 * 1000,
          },
        ]);

        const token = threadSandbox!.env.FX_RUNNER_TOKEN!;
        assert.match(token, /^[0-9a-f-]{36}$/);
        assert.deepEqual(threadSandbox, {
          name: "t3-thread-1",
          source: { kind: "snapshot", snapshotId: "snap-t3-image-proj-1-1" },
          timeoutMs: 86_400_000,
          ports: [8080],
          networkPolicy: {
            allow: {
              "ai-gateway.vercel.sh": [
                { transform: [{ headers: { authorization: "Bearer gw-key-1" } }] },
              ],
              "api.vercel.com": [],
              "registry.npmjs.org": [],
              "registry.yarnpkg.com": [],
              "github.com": [],
              "api.github.com": [],
            },
          },
          env: { FX_RUNNER_TOKEN: token, FX_RUNNER_PORT: "8080", FX_RUNNER_HOST: "0.0.0.0" },
          tags: { t3code: "thread", threadId: "Thread-1", projectId: "proj-1" },
          snapshotExpirationMs: 7 * 24 * 60 * 60 * 1000,
          keepLastSnapshots: { count: 1 },
        });
        assert.deepEqual(
          harness.fake.calls
            .filter((call) => call.sandbox === "t3-thread-1")
            .map((call) => `${call.op}:${call.detail}`),
          [
            "writeFiles:/vercel/sandbox/.t3/workspace.bundle",
            "run:git clone --quiet /vercel/sandbox/.t3/workspace.bundle /vercel/sandbox/My-App",
            "run:rm -f /vercel/sandbox/.t3/workspace.bundle",
            "runDetached:node /opt/t3code/fx-runner/bin.mjs",
            "domain:8080",
          ],
        );
        assert.deepEqual(
          harness.fake.files.get("/vercel/sandbox/.t3/workspace.bundle"),
          bundleBytes,
        );
        assert.deepEqual(harness.connects, [
          {
            url: "wss://t3-thread-1-8080.sandbox.test",
            token,
            threadId,
            placement: {
              kind: "sandbox",
              rootDir: "/vercel/sandbox/My-App",
              sandboxName: "t3-thread-1",
              apiKey: SANDBOX_INJECTED_API_KEY,
            },
          },
        ]);
        assert.deepEqual(first.link.placement, harness.connects[0]!.placement);

        // A second thread on the same project reuses the persisted snapshot.
        const second = yield* launchInScope({ threadId: ThreadId.make("thread-2"), projectId });
        assert.equal(harness.fake.creates.length, 3);
        assert.deepEqual(harness.fake.creates[2]!.source, {
          kind: "snapshot",
          snapshotId: "snap-t3-image-proj-1-1",
        });

        // `get` reads the store file on every call, so this proves persistence to disk.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        assert.isTrue(yield* fs.exists(path.join(config.stateDir, "sandbox-images.json")));
        const images = yield* ProjectSandboxImages.ProjectSandboxImages;
        const record = yield* images.get(projectId);
        assert.equal(record?.snapshotId, "snap-t3-image-proj-1-1");
        assert.equal(record?.baseImage, "t3code-agent:latest");

        // Closing a session scope stops exactly that thread's sandbox.
        yield* Scope.close(first.scope, Exit.void);
        assert.deepEqual(Array.from(harness.fake.stopped), ["t3-image-proj-1", "t3-thread-1"]);
        yield* Scope.close(second.scope, Exit.void);
        assert.isTrue(harness.fake.stopped.has("t3-thread-2"));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("boots from the base image when the thread has no project", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        yield* withGatewayKey;
        const { scope } = yield* launchInScope({ threadId });
        assert.equal(harness.fake.creates.length, 1);
        assert.deepEqual(harness.fake.creates[0]!.source, {
          kind: "image",
          image: "t3code-agent:latest",
        });
        assert.deepEqual(harness.fake.creates[0]!.tags, { t3code: "thread", threadId: "Thread-1" });
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("rebuilds the project image when its persisted snapshot is gone", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        failCreate: (params) =>
          params.source.kind === "snapshot" && params.source.snapshotId === "snap-t3-image-proj-1-1"
            ? new SandboxSnapshotGoneError({ snapshotId: params.source.snapshotId })
            : undefined,
      });
      yield* Effect.gen(function* () {
        yield* withGatewayKey;
        const { scope } = yield* launchInScope({ threadId, projectId });
        assert.deepEqual(
          harness.fake.creates.map((create) => `${create.name}:${JSON.stringify(create.source)}`),
          [
            't3-image-proj-1:{"kind":"image","image":"t3code-agent:latest"}',
            't3-image-proj-1:{"kind":"image","image":"t3code-agent:latest"}',
            't3-thread-1:{"kind":"snapshot","snapshotId":"snap-t3-image-proj-1-2"}',
          ],
        );
        const images = yield* ProjectSandboxImages.ProjectSandboxImages;
        assert.equal((yield* images.get(projectId))?.snapshotId, "snap-t3-image-proj-1-2");
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unbuilt image as a process error that says how to build it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        failCreate: (params) =>
          params.source.kind === "image"
            ? new SandboxImageNotReadyError({
                image: params.source.image,
                detail: "image_not_ready.",
              })
            : undefined,
      });
      yield* Effect.gen(function* () {
        yield* withGatewayKey;
        const exit = yield* launchInScope({ threadId }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        const message = Exit.isFailure(exit) ? String(exit.cause) : "";
        assert.include(message, "Sandbox image 't3code-agent:latest' is not ready");
        assert.include(message, "scripts/build-sandbox-image.ts");
        assert.deepEqual(harness.fake.creates, []);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to launch without a gateway key instead of shipping a broken runner", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const exit = yield* launchInScope({ threadId }).pipe(Effect.exit);
        const message = Exit.isFailure(exit) ? String(exit.cause) : "";
        assert.include(message, "needs an AI Gateway key");
        assert.deepEqual(harness.fake.creates, []);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("isEnabled follows the settings", () =>
    Effect.gen(function* () {
      const on = makeHarness();
      const off = makeHarness({}, { enabled: true, projectId: "" });
      const enabled = yield* Effect.flatMap(
        SandboxRunnerBackend.SandboxRunnerBackend,
        (backend) => backend.isEnabled,
      ).pipe(Effect.provide(on.layer));
      const disabled = yield* Effect.flatMap(
        SandboxRunnerBackend.SandboxRunnerBackend,
        (backend) => backend.isEnabled,
      ).pipe(Effect.provide(off.layer));
      assert.deepEqual([enabled, disabled], [true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("reaps running thread sandboxes this server does not own", () =>
    Effect.gen(function* () {
      const listing = (
        name: string,
        status: SandboxListing["status"],
        tags: Record<string, string>,
      ) => ({ name, status, tags, createdAt: 1 }) satisfies SandboxListing;
      const harness = makeHarness({
        existing: [
          listing("t3-thread-1", "running", { t3code: "thread", threadId: "Thread-1" }),
          listing("t3-orphan", "running", { t3code: "thread", threadId: "orphan" }),
          listing("t3-pending-orphan", "pending", { t3code: "thread", threadId: "p" }),
          listing("t3-done", "stopped", { t3code: "thread", threadId: "done" }),
          listing("t3-image-proj-1", "running", { t3code: "image", projectId: "proj-1" }),
          listing("other-app", "running", { t3code: "thread" }),
        ],
      });
      yield* Effect.gen(function* () {
        yield* withGatewayKey;
        const { scope } = yield* launchInScope({ threadId });
        const backend = yield* SandboxRunnerBackend.SandboxRunnerBackend;
        const stopped = yield* backend.reapOrphans;
        assert.deepEqual(stopped, ["t3-orphan", "t3-pending-orphan"]);
        assert.isFalse(harness.fake.stopped.has("t3-thread-1"));
        // The fake never flips a listing to stopped, so once the session scope
        // closes its sandbox reads as an orphan too.
        yield* Scope.close(scope, Exit.void);
        assert.deepEqual(yield* backend.reapOrphans, [
          "t3-thread-1",
          "t3-orphan",
          "t3-pending-orphan",
        ]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );
});

describe("selectOrphanSandboxes", () => {
  it("keeps only running thread sandboxes outside the live set", () => {
    const listings: SandboxListing[] = [
      { name: "t3-a", status: "running", tags: { t3code: "thread" }, createdAt: 1 },
      { name: "t3-b", status: "running", tags: { t3code: "thread" }, createdAt: 1 },
      { name: "t3-c", status: "stopped", tags: { t3code: "thread" }, createdAt: 1 },
      { name: "t3-image-x", status: "running", tags: { t3code: "image" }, createdAt: 1 },
      { name: "x-t3-d", status: "running", tags: { t3code: "thread" }, createdAt: 1 },
    ];
    assert.deepEqual(
      SandboxRunnerBackend.selectOrphanSandboxes(listings, new Set(["t3-a"])).map((l) => l.name),
      ["t3-b"],
    );
  });
});

describe("sandboxWorkspaceDir", () => {
  it("places the clone under the sandbox home by folder name, slugged", () => {
    assert.equal(sandboxWorkspaceDir("/Users/dev/My App"), "/vercel/sandbox/My-App");
    assert.equal(sandboxWorkspaceDir("/srv/repo/"), "/vercel/sandbox/repo");
    assert.equal(sandboxWorkspaceDir("/"), "/vercel/sandbox/workspace");
  });
});

describe("classifyCreateError", () => {
  const params = (
    source: { kind: "image"; image: string } | { kind: "snapshot"; snapshotId: string },
  ) => ({
    name: "t3-x",
    source,
    timeoutMs: 1,
    ports: [],
    networkPolicy: sandboxNetworkPolicy(undefined),
    env: {},
    tags: {},
    snapshotExpirationMs: 1,
    keepLastSnapshots: { count: 1 },
  });

  it("maps image_not_ready onto SandboxImageNotReadyError", () => {
    const error = classifyCreateError(
      params({ kind: "image", image: "t3code-agent:latest" }),
      new APIError(new Response("", { status: 400 }), {
        message: "Image is not ready",
        json: { error: { code: "image_not_ready" } },
      }),
    );
    assert.equal(error._tag, "SandboxImageNotReadyError");
  });

  it("maps a missing snapshot onto SandboxSnapshotGoneError", () => {
    const error = classifyCreateError(
      params({ kind: "snapshot", snapshotId: "snap_1" }),
      new APIError(new Response("", { status: 404 }), { message: "Not found" }),
    );
    assert.deepEqual(error, new SandboxSnapshotGoneError({ snapshotId: "snap_1" }));
  });

  it("keeps everything else as SandboxApiError", () => {
    const error = classifyCreateError(
      params({ kind: "image", image: "t3code-agent:latest" }),
      new Error("socket hang up"),
    );
    assert.equal(error._tag, "SandboxApiError");
    assert.include(error.message, "socket hang up");
  });
});
