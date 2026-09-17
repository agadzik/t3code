import { describe, expect, it } from "vite-plus/test";
import type { VercelAuthStatus } from "@t3tools/contracts";

import {
  parseVercelCallbackSearch,
  resolveVercelAuthStatus,
  sameOriginVercelAuthorizePath,
  vercelAccountView,
  vercelCallbackToast,
  withoutVercelCallbackSearch,
} from "./VercelAccountSection.logic";

function status(patch: Partial<VercelAuthStatus> = {}): VercelAuthStatus {
  return {
    status: "disconnected",
    hasGatewayKey: false,
    hasApiToken: false,
    ...patch,
  };
}

describe("parseVercelCallbackSearch", () => {
  it("accepts only the OAuth callback flags", () => {
    expect(parseVercelCallbackSearch("connected")).toBe("connected");
    expect(parseVercelCallbackSearch("error")).toBe("error");
    expect(parseVercelCallbackSearch("pending")).toBeUndefined();
    expect(parseVercelCallbackSearch(undefined)).toBeUndefined();
    expect(parseVercelCallbackSearch(1)).toBeUndefined();
  });
});

describe("withoutVercelCallbackSearch", () => {
  it("drops vercel and keeps the rest of the providers search", () => {
    expect(
      withoutVercelCallbackSearch({
        vercel: "connected",
        environmentId: "env-1",
        instanceId: "codex",
      }),
    ).toEqual({ environmentId: "env-1", instanceId: "codex" });
    expect(withoutVercelCallbackSearch({ environmentId: "env-1" })).toEqual({
      environmentId: "env-1",
    });
  });
});

describe("vercelCallbackToast", () => {
  it("returns the one-shot toast for each callback flag", () => {
    expect(vercelCallbackToast("connected")).toEqual({
      type: "success",
      title: "Signed in with Vercel",
    });
    expect(vercelCallbackToast("error")).toEqual({
      type: "error",
      title: "Vercel sign-in failed",
    });
  });
});

describe("resolveVercelAuthStatus", () => {
  it("prefers the getStatus query, then config, then nothing", () => {
    const query = status({ status: "connected", accountName: "Query" });
    const fromConfig = status({ status: "pending" });
    expect(resolveVercelAuthStatus({ query, fromConfig })).toEqual(query);
    expect(resolveVercelAuthStatus({ query: null, fromConfig })).toEqual(fromConfig);
    expect(resolveVercelAuthStatus({ query: null, fromConfig: undefined })).toBeNull();
  });
});

describe("vercelAccountView", () => {
  it("maps each status into the settings panel view", () => {
    expect(vercelAccountView(null)).toEqual({ kind: "unknown" });
    expect(vercelAccountView(status())).toEqual({ kind: "disconnected", error: undefined });
    expect(vercelAccountView(status({ status: "error", error: "missing client id" }))).toEqual({
      kind: "disconnected",
      error: "missing client id",
    });
    expect(vercelAccountView(status({ status: "pending" }))).toEqual({ kind: "pending" });
    expect(
      vercelAccountView(
        status({
          status: "connected",
          accountName: "Acme",
          username: "jane",
          hasGatewayKey: true,
          hasApiToken: false,
        }),
      ),
    ).toEqual({
      kind: "connected",
      heading: "Acme",
      username: "jane",
      hasGatewayKey: true,
      hasApiToken: false,
    });
    expect(
      vercelAccountView(status({ status: "connected", username: "jane", hasGatewayKey: true })),
    ).toEqual({
      kind: "connected",
      heading: "jane",
      username: undefined,
      hasGatewayKey: true,
      hasApiToken: false,
    });
  });
});

describe("sameOriginVercelAuthorizePath", () => {
  it("accepts a same-origin path and rejects anything else", () => {
    expect(sameOriginVercelAuthorizePath("/api/auth/vercel/authorize")).toBe(
      "/api/auth/vercel/authorize",
    );
    expect(sameOriginVercelAuthorizePath("  /api/auth/vercel/authorize?x=1  ")).toBe(
      "/api/auth/vercel/authorize?x=1",
    );
    expect(sameOriginVercelAuthorizePath("//evil.example/phish")).toBeNull();
    expect(sameOriginVercelAuthorizePath("https://vercel.com/oauth/authorize")).toBeNull();
    expect(sameOriginVercelAuthorizePath("javascript:alert(1)")).toBeNull();
  });
});
