import { describe, expect, it } from "vite-plus/test";

import {
  SANDBOX_EGRESS_ALLOWLIST,
  SANDBOX_INJECTED_API_KEY,
  sandboxNetworkPolicy,
} from "./vercelSandbox.ts";

describe("sandboxNetworkPolicy", () => {
  it("denies by default and injects the gateway key only for the gateway host", () => {
    expect(sandboxNetworkPolicy("gw-secret")).toEqual({
      allow: {
        "ai-gateway.vercel.sh": [
          { transform: [{ headers: { authorization: "Bearer gw-secret" } }] },
        ],
        "api.vercel.com": [],
        "registry.npmjs.org": [],
        "registry.yarnpkg.com": [],
        "github.com": [],
        "api.github.com": [],
      },
    });
  });

  it("keeps the same hosts, with no injection, when no key is available", () => {
    const policy = sandboxNetworkPolicy(undefined);
    expect(policy).toEqual({
      allow: {
        "ai-gateway.vercel.sh": [],
        "api.vercel.com": [],
        "registry.npmjs.org": [],
        "registry.yarnpkg.com": [],
        "github.com": [],
        "api.github.com": [],
      },
    });
    expect(Object.keys(policy.allow)).toEqual([
      "ai-gateway.vercel.sh",
      ...SANDBOX_EGRESS_ALLOWLIST,
    ]);
  });

  it("never lets the placeholder key look like a real one", () => {
    expect(JSON.stringify(sandboxNetworkPolicy("gw-secret"))).not.toContain(
      SANDBOX_INJECTED_API_KEY,
    );
  });
});
