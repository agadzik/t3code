import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

/**
 * `vp pack` here produces the sandbox-image runner: one `dist/bin.mjs` with
 * `effect` and `ws` inlined. `libfx` stays external because it loads a native
 * addon (`libfx.linux-x64.node`) and wasm by path; the image installs it with
 * npm next to the bundle (see `scripts/bundle.ts` and `infra/sandbox-image`).
 */
const isLibfx = (id: string) => id === "libfx" || id.startsWith("libfx/");

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      format: ["esm"],
      clean: true,
      sourcemap: false,
      dts: false,
      deps: {
        alwaysBundle: (id: string) => !isLibfx(id),
        neverBundle: isLibfx,
        onlyBundle: false,
      },
    },
  }),
);
