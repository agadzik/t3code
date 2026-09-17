import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { refreshUsageLimits } from "./usage.ts";

describe("limits refresh cooldown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("joins manual calls and gates automatic refreshes after success or failure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    for (const fails of [false, true]) {
      const id = EnvironmentId.make(`limits-${fails}`);
      const pending = Promise.withResolvers<string>();
      const refresh = vi.fn(() => pending.promise);
      const first = refreshUsageLimits(id, refresh, true);
      await refreshUsageLimits(id, refresh, true);
      const manual = refreshUsageLimits(id, refresh);
      const settled = vi.fn();
      void manual.then(settled, settled);
      expect(settled).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
      if (fails) {
        const firstFailure = expect(first).rejects.toThrow("unavailable");
        const manualFailure = expect(manual).rejects.toThrow("unavailable");
        pending.reject(new Error("unavailable"));
        await Promise.all([firstFailure, manualFailure]);
      } else {
        pending.resolve("quota");
        expect(await first).toBe("quota");
        expect(await manual).toBe("quota");
      }
      expect(settled).toHaveBeenCalledTimes(1);
      const next = vi.fn(async () => undefined);
      clock.mockReturnValue(300_999);
      await refreshUsageLimits(id, next, true);
      expect(next).not.toHaveBeenCalled();
      clock.mockReturnValue(301_000);
      await refreshUsageLimits(id, next, true);
      expect(next).toHaveBeenCalledTimes(1);
      await refreshUsageLimits(id, next);
      expect(next).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(1_000);
    }
  });
});
