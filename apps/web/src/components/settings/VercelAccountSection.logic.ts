import type { VercelAuthStatus } from "@t3tools/contracts";

export type VercelCallbackFlag = "connected" | "error";

export type VercelAccountView =
  | { readonly kind: "unknown" }
  | { readonly kind: "disconnected"; readonly error: string | undefined }
  | { readonly kind: "pending" }
  | {
      readonly kind: "connected";
      readonly heading: string;
      readonly username: string | undefined;
      readonly hasGatewayKey: boolean;
      readonly hasApiToken: boolean;
    };

export function parseVercelCallbackSearch(value: unknown): VercelCallbackFlag | undefined {
  return value === "connected" || value === "error" ? value : undefined;
}

export function withoutVercelCallbackSearch<T extends object>(search: T): Omit<T, "vercel"> {
  const { vercel: _vercel, ...rest } = search as T & { readonly vercel?: unknown };
  return rest;
}

export function vercelCallbackToast(flag: VercelCallbackFlag): {
  readonly type: "success" | "error";
  readonly title: string;
} {
  return flag === "connected"
    ? { type: "success", title: "Signed in with Vercel" }
    : { type: "error", title: "Vercel sign-in failed" };
}

export function resolveVercelAuthStatus(input: {
  readonly query: VercelAuthStatus | null;
  readonly fromConfig: VercelAuthStatus | undefined;
}): VercelAuthStatus | null {
  return input.query ?? input.fromConfig ?? null;
}

export function vercelAccountView(status: VercelAuthStatus | null): VercelAccountView {
  if (status === null) return { kind: "unknown" };
  switch (status.status) {
    case "pending":
      return { kind: "pending" };
    case "connected": {
      const heading = status.accountName ?? status.username ?? "Vercel account";
      const username =
        status.username !== undefined && status.username !== heading ? status.username : undefined;
      return {
        kind: "connected",
        heading,
        username,
        hasGatewayKey: status.hasGatewayKey,
        hasApiToken: status.hasApiToken,
      };
    }
    case "disconnected":
    case "error":
      return { kind: "disconnected", error: status.error };
    default: {
      const _exhaustive: never = status.status;
      return _exhaustive;
    }
  }
}

/** OAuth start returns a same-origin path. Reject anything else so the SPA cannot be sent off-origin. */
export function sameOriginVercelAuthorizePath(authorizationUrl: string): string | null {
  const trimmed = authorizationUrl.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return null;
}
