/**
 * Vercel Sandbox execution for fx runners: settings, the egress policy, and
 * the two facts the server and the sandbox image must agree on (where the
 * runner lives and which port it listens on).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

/** VCR repository the sandbox image build script pushes to, and the default image threads start from. */
export const DEFAULT_VERCEL_SANDBOX_IMAGE = "t3code-agent:latest";

/**
 * Where fx runners execute. When `enabled` and a team and project are set,
 * every new fx session boots a Vercel Sandbox from `image` (or the project's
 * dependency snapshot) instead of a local child process. The Vercel API token
 * itself lives in the secret store, never here.
 */
export const VercelSandboxSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  teamId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  projectId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  image: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VERCEL_SANDBOX_IMAGE)),
  ),
});
export type VercelSandboxSettings = typeof VercelSandboxSettings.Type;

/** Where the image's Dockerfile installs the bundled runner (see infra/sandbox-image). */
export const SANDBOX_RUNNER_ENTRYPOINT = "/opt/t3code/fx-runner/bin.mjs";
/** The runner listens here inside the sandbox; the host connects through `sandbox.domain(port)`. */
export const SANDBOX_RUNNER_PORT = 8080;

export const AI_GATEWAY_HOST = "ai-gateway.vercel.sh";

/** What the runner sends as its gateway key inside a sandbox. Egress replaces it. */
export const SANDBOX_INJECTED_API_KEY = "sandbox-egress-injected";

/**
 * Hosts allowed without credential injection: Vercel API (vercel CLI), npm and
 * yarn registries (dependency installs), GitHub (git and gh).
 */
export const SANDBOX_EGRESS_ALLOWLIST = [
  "api.vercel.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "api.github.com",
] as const;

/**
 * The object form of `@vercel/sandbox`'s `NetworkPolicy`, restated so contracts
 * stay SDK-free. Mutable on purpose: the SDK's parameter type is mutable and a
 * readonly shape would not be assignable to it.
 */
export interface SandboxNetworkPolicy {
  allow: Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>>;
}

/**
 * Egress policy for every T3 sandbox. Deny by default; the listed hosts are
 * the only destinations a runner (and whatever the agent shells out to) can
 * reach. The AI Gateway rule injects the real key at the firewall, so the key
 * never enters the sandbox. Without a key (project image builds) the gateway
 * host stays reachable but nothing is injected.
 */
export const sandboxNetworkPolicy = (gatewayKey: string | undefined): SandboxNetworkPolicy => ({
  allow: {
    [AI_GATEWAY_HOST]:
      gatewayKey === undefined
        ? []
        : [{ transform: [{ headers: { authorization: `Bearer ${gatewayKey}` } }] }],
    "api.vercel.com": [],
    "registry.npmjs.org": [],
    "registry.yarnpkg.com": [],
    "github.com": [],
    "api.github.com": [],
  },
});
