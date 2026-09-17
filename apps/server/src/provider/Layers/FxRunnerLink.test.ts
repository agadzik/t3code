import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeFxRunnerLauncher } from "./FxRunnerLink.ts";

// Agent creation in libfx is local (no gateway request), so a placeholder key
// exercises the spawn, listening handshake, bearer auth, and init round trip
// without any network access.
describe("FxRunnerLink", () => {
  it.effect("spawns the runner, connects with the bearer token, and closes cleanly", () =>
    Effect.gen(function* () {
      const launcher = yield* makeFxRunnerLauncher({ environment: process.env });
      const link = yield* launcher.launch({
        threadId: ThreadId.make("link-thread"),
        cwd: process.cwd(),
      });
      yield* link.send({ type: "init", apiKey: "placeholder-key", rootDir: process.cwd() });
      const frames = yield* link.frames.pipe(
        Stream.tap((frame) =>
          frame.type === "ready" ? link.send({ type: "close" }) : Effect.void,
        ),
        Stream.runCollect,
      );
      assert.deepEqual(Array.from(frames), [{ type: "ready" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
