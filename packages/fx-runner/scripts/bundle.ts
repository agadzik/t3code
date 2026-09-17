/**
 * Produce the runner directory the sandbox image copies in:
 *
 *   dist/bin.mjs       runner + effect + ws, one file (`vp pack`, see vite.config.ts)
 *   dist/package.json  declares `libfx` so `npm install` inside the image
 *                      fetches the package with its linux-x64 native addon
 *
 * `libfx` is not bundled because it resolves `libfx.<platform>.node` and the
 * wasm files relative to its own package directory. Installing it with npm in
 * the image is the simplest thing that keeps those paths intact.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const packageDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const distDir = NodePath.join(packageDir, "dist");
const vp = NodePath.join(packageDir, "..", "..", "node_modules", ".bin", "vp");

const runnerPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
) as { readonly dependencies: Readonly<Record<string, string>> };
const libfxVersion = runnerPackage.dependencies.libfx;
if (libfxVersion === undefined) {
  throw new Error("packages/fx-runner/package.json must declare libfx.");
}

const pack = NodeChildProcess.spawnSync(vp, ["pack"], { cwd: packageDir, stdio: "inherit" });
if (pack.status !== 0) {
  throw new Error(`vp pack exited with ${pack.status ?? pack.signal}`);
}

NodeFS.writeFileSync(
  NodePath.join(distDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@t3tools/fx-runner-sandbox",
      private: true,
      type: "module",
      dependencies: { libfx: libfxVersion },
    },
    null,
    2,
  )}\n`,
);

const entry = NodePath.join(distDir, "bin.mjs");
if (!NodeFS.existsSync(entry)) {
  throw new Error(`vp pack did not write ${entry}`);
}
console.log(`runner bundle ready at ${distDir} (libfx ${libfxVersion} installed by the image)`);
