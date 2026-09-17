/**
 * SandboxReaper - periodically stops thread sandboxes no live session owns.
 *
 * A server that crashes leaves its sandboxes running until their 24 hour
 * timeout. This sweep lists `t3-*` sandboxes tagged as thread sandboxes and
 * stops the ones this process did not launch. It only runs while sandbox
 * execution is configured, so an unconfigured server never calls Vercel.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../serverActivation.ts";
import { SandboxRunnerBackend } from "./SandboxRunnerBackend.ts";

const SANDBOX_REAPER_INTERVAL = Duration.minutes(10);

const makeSandboxReaperLive = (interval: Duration.Duration = SANDBOX_REAPER_INTERVAL) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const backend = yield* SandboxRunnerBackend;
      const sweep = Effect.gen(function* () {
        if (!(yield* backend.isEnabled)) return;
        const stopped = yield* backend.reapOrphans;
        if (stopped.length > 0) {
          yield* Effect.logInfo("sandbox.reaper.sweep-complete", { stopped });
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("sandbox.reaper.sweep-failed", { error })));
      yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(interval))));
    }),
  );

export const SandboxReaperLive = makeSandboxReaperLive();
