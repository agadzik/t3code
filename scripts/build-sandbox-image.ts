// @effect-diagnostics nodeBuiltinImport:off
/**
 * Build the T3 agent sandbox image and push it to Vercel Container Registry.
 *
 *   node scripts/build-sandbox-image.ts               bundle runner, build, push t3code-agent:latest
 *   node scripts/build-sandbox-image.ts --no-push     bundle runner, build only
 *   node scripts/build-sandbox-image.ts --dry-run     print every command, run none
 *   node scripts/build-sandbox-image.ts -- --scope my-team   (anything after `--` goes to `vercel vcr build`)
 *
 * Needs a Vercel CLI with the `vcr` subcommand. Older CLIs (54.x) lack it; the
 * script detects that and prints the upgrade and the plain docker fallback.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { DEFAULT_VERCEL_SANDBOX_IMAGE } from "@t3tools/contracts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const runnerDist = NodePath.join(repoRoot, "packages", "fx-runner", "dist");
const imageDir = NodePath.join(repoRoot, "infra", "sandbox-image");
const imageRunnerDir = NodePath.join(imageDir, "runner");

const argv = process.argv.slice(2);
const passthroughIndex = argv.indexOf("--");
const flags = new Set(passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex));
const vcrExtraArgs = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1);
const dryRun = flags.has("--dry-run");
const push = !flags.has("--no-push");

const log = (line: string) => process.stdout.write(`${line}\n`);

function run(command: string, args: ReadonlyArray<string>, cwd: string): void {
  log(`$ (cd ${NodePath.relative(repoRoot, cwd) || "."} && ${[command, ...args].join(" ")})`);
  if (dryRun) return;
  const result = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

/** Whether the installed Vercel CLI knows `vcr`. 54.x answers "not a valid target directory or subcommand". */
export function vercelCliHasVcr(probe: {
  readonly status: number | null;
  readonly output: string;
}): boolean {
  return probe.status === 0 && !/not a valid target directory or subcommand/i.test(probe.output);
}

function probeVercelVcr(): { readonly status: number | null; readonly output: string } {
  const result = NodeChildProcess.spawnSync("vercel", ["vcr", "--help"], { encoding: "utf8" });
  if (result.error) return { status: null, output: result.error.message };
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function printVcrRemediation(probe: {
  readonly status: number | null;
  readonly output: string;
}): void {
  const lines = probe.output.split("\n").filter((line) => line.trim() !== "");
  const firstLine = lines.find((line) => /error/i.test(line)) ?? lines[0] ?? "(no output)";
  process.stderr.write(
    [
      "",
      `The installed Vercel CLI cannot run \`vercel vcr\` (${firstLine.trim()}).`,
      "",
      "Fix, either:",
      "  1. Upgrade the CLI and rerun this script:",
      "       npm install -g vercel@latest",
      `       node scripts/build-sandbox-image.ts`,
      "",
      "  2. Or push with plain docker (needs a Vercel API token with access to the team; the login",
      "     also lets docker pull the vcr.vercel.com/vercel/sandbox/node:24 base image):",
      "       docker login vcr.vercel.com -u <vercel-user-or-team-slug> -p $VERCEL_TOKEN",
      `       docker build --platform linux/amd64 -t vcr.vercel.com/<team-slug>/<project-slug>/${DEFAULT_VERCEL_SANDBOX_IMAGE} ${NodePath.relative(repoRoot, imageDir)}`,
      `       docker push vcr.vercel.com/<team-slug>/<project-slug>/${DEFAULT_VERCEL_SANDBOX_IMAGE}`,
      "",
      "  The runner bundle is already staged under infra/sandbox-image/runner for either path.",
      "  VCR then prepares a linux/amd64 build; Sandbox.create answers image_not_ready until it is Ready.",
      "",
    ].join("\n"),
  );
}

function main(): void {
  run("node", ["packages/fx-runner/scripts/bundle.ts"], repoRoot);

  log(
    `staging ${NodePath.relative(repoRoot, runnerDist)} -> ${NodePath.relative(repoRoot, imageRunnerDir)}`,
  );
  if (!dryRun) {
    NodeFS.rmSync(imageRunnerDir, { recursive: true, force: true });
    NodeFS.cpSync(runnerDist, imageRunnerDir, { recursive: true });
    for (const required of ["bin.mjs", "package.json"]) {
      if (!NodeFS.existsSync(NodePath.join(imageRunnerDir, required))) {
        throw new Error(`runner bundle is missing ${required}`);
      }
    }
  }

  const probe = dryRun ? { status: 0, output: "" } : probeVercelVcr();
  if (!vercelCliHasVcr(probe)) {
    printVcrRemediation(probe);
    process.exitCode = 2;
    return;
  }

  run(
    "vercel",
    [
      "vcr",
      "build",
      "docker",
      ".",
      DEFAULT_VERCEL_SANDBOX_IMAGE,
      ...(push ? ["--push"] : []),
      ...vcrExtraArgs,
    ],
    imageDir,
  );
  log(
    push
      ? `pushed ${DEFAULT_VERCEL_SANDBOX_IMAGE}. VCR now prepares the linux/amd64 build; sandboxes can start once the repository shows Ready.`
      : `built ${DEFAULT_VERCEL_SANDBOX_IMAGE} locally (not pushed).`,
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
