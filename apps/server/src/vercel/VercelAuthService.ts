// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetchInEffect:off -- tests stub globalThis.fetch for the Vercel HTTP boundary.
import * as NodeCrypto from "node:crypto";
import {
  VercelAuthError,
  type VercelAuthStartResult,
  type VercelAuthStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const VERCEL_AUTHORIZE_PATH = "/api/auth/vercel/authorize";
export const VERCEL_CALLBACK_PATH = "/api/auth/vercel/callback";
export const VERCEL_SIGNOUT_PATH = "/api/auth/vercel/signout";
export const VERCEL_OAUTH_SECRET_NAME = "vercel-oauth";
export const VERCEL_GATEWAY_KEY_SECRET_NAME = "vercel-gateway-key";
export const VERCEL_API_TOKEN_SECRET_NAME = "vercel-api-token";

const VERCEL_AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const VERCEL_TOKEN_URL = "https://api.vercel.com/login/oauth/token";
const VERCEL_REVOKE_URL = "https://api.vercel.com/login/oauth/token/revoke";
const VERCEL_USERINFO_URL = "https://api.vercel.com/login/oauth/userinfo";
const VERCEL_API_KEYS_URL = "https://api.vercel.com/v1/api-keys";
const VERCEL_OAUTH_SCOPE = "openid email profile offline_access";
const GATEWAY_KEY_NAME = "t3code-fx";
const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 3600;
const MISSING_CONFIG_DETAIL =
  "Sign in with Vercel is not configured. Set VERCEL_APP_CLIENT_ID and VERCEL_APP_CLIENT_SECRET.";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const VercelTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
});

const VercelOauthSecret = Schema.Struct({
  refreshToken: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Finite,
  accountName: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  teamId: Schema.optionalKey(Schema.String),
  gatewayProvisionError: Schema.optionalKey(Schema.String),
});
type VercelOauthSecret = typeof VercelOauthSecret.Type;

const GatewayKeyRequest = Schema.Struct({
  purpose: Schema.Literal("ai-gateway"),
  name: Schema.String,
});

const decodeOauthSecret = Schema.decodeUnknownEffect(Schema.fromJsonString(VercelOauthSecret));
const encodeOauthSecret = Schema.encodeUnknownEffect(Schema.fromJsonString(VercelOauthSecret));
const decodeTokenResponse = Schema.decodeUnknownEffect(VercelTokenResponse);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeGatewayKeyRequest = Schema.encodeUnknownEffect(
  Schema.fromJsonString(GatewayKeyRequest),
);
const isVercelAuthError = Schema.is(VercelAuthError);

type PendingAttempt = {
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
};

type VercelAppCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export interface VercelAuthServiceShape {
  readonly start: () => Effect.Effect<VercelAuthStartResult, VercelAuthError>;
  readonly getStatus: () => Effect.Effect<VercelAuthStatus>;
  readonly logout: () => Effect.Effect<VercelAuthStatus, VercelAuthError>;
  readonly setApiToken: (token: string) => Effect.Effect<VercelAuthStatus, VercelAuthError>;
  readonly setGatewayKey: (key: string) => Effect.Effect<VercelAuthStatus, VercelAuthError>;
  readonly getValidAccessToken: () => Effect.Effect<Option.Option<string>, VercelAuthError>;
  readonly getValidGatewayKey: () => Effect.Effect<Option.Option<string>, VercelAuthError>;
  /** The manually pasted Vercel API token. Sandbox and VCR calls authenticate with it. */
  readonly getValidApiToken: () => Effect.Effect<Option.Option<string>, VercelAuthError>;
  readonly handleAuthorize: () => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly handleCallback: () => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly handleSignout: () => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

export class VercelAuthService extends Context.Service<VercelAuthService, VercelAuthServiceShape>()(
  "t3/vercel/VercelAuthService",
) {}

const jsonErrorResponse = (status: number, error: string) =>
  HttpServerResponse.text(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });

const settingsRedirect = (result: "connected" | "error") =>
  HttpServerResponse.redirect(`/settings/providers?vercel=${result}`, { status: 302 });

const readCredentials = (): VercelAppCredentials | undefined => {
  const clientId = process.env.VERCEL_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
};

const missingConfigError = (operation: string) =>
  new VercelAuthError({
    operation,
    detail: MISSING_CONFIG_DETAIL,
  });

const randomUrlSafe = (bytes: number): string =>
  NodeCrypto.randomBytes(bytes).toString("base64url");

const s256Challenge = (verifier: string): string =>
  NodeCrypto.createHash("sha256").update(verifier).digest().toString("base64url");

const requestUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request);

const jwtNonce = (idToken: string): string | undefined => {
  const parts = idToken.split(".");
  if (parts.length < 2 || parts[1] === undefined) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      nonce?: unknown;
    };
    return typeof payload.nonce === "string" ? payload.nonce : undefined;
  } catch {
    return undefined;
  }
};

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const accountFromUserinfo = (
  body: unknown,
): {
  readonly accountName?: string;
  readonly username?: string;
  readonly teamId?: string;
} => {
  if (body === null || typeof body !== "object") return {};
  const rec = body as Record<string, unknown>;
  const name = nonEmpty(rec.name);
  const preferred = nonEmpty(rec.preferred_username);
  const email = nonEmpty(rec.email);
  const teamId = nonEmpty(rec.team_id) ?? nonEmpty(rec.teamId);
  const accountName = name ?? preferred ?? email;
  const username = preferred ?? email;
  return {
    ...(accountName !== undefined ? { accountName } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
  };
};

const extractGatewayKey = (body: unknown): string | undefined => {
  if (body === null || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  const direct = nonEmpty(rec.key) ?? nonEmpty(rec.apiKey) ?? nonEmpty(rec.token);
  if (direct !== undefined) return direct;
  const data = rec.data;
  if (data === null || typeof data !== "object") return undefined;
  return nonEmpty((data as { key?: unknown }).key);
};

const basicAuthHeader = (credentials: VercelAppCredentials): string =>
  `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;

type VercelHttpResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
};

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const pending = new Map<string, PendingAttempt>();
  const oauthLock = yield* Semaphore.make(1);

  const storeError = (operation: string, cause: unknown) =>
    new VercelAuthError({
      operation,
      detail: "Could not update stored Vercel credentials.",
      cause,
    });

  const readUtf8Secret = (name: string) =>
    secretStore.get(name).pipe(
      Effect.map((bytes) => Option.map(bytes, (value) => textDecoder.decode(value))),
      Effect.mapError(
        (cause) =>
          new VercelAuthError({
            operation: "read-secret",
            detail: "Could not read stored Vercel credentials.",
            cause,
          }),
      ),
    );

  const writeUtf8Secret = (name: string, value: string) =>
    secretStore
      .set(name, textEncoder.encode(value))
      .pipe(Effect.mapError((cause) => storeError("write-secret", cause)));

  const removeSecret = (name: string) =>
    secretStore.remove(name).pipe(Effect.mapError((cause) => storeError("remove-secret", cause)));

  const readOauthSecret = Effect.fn("VercelAuthService.readOauthSecret")(function* () {
    const raw = yield* readUtf8Secret(VERCEL_OAUTH_SECRET_NAME);
    if (Option.isNone(raw)) return Option.none<VercelOauthSecret>();
    return yield* decodeOauthSecret(raw.value).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new VercelAuthError({
            operation: "decode-secret",
            detail: "Stored Vercel credentials are unreadable.",
            cause,
          }),
      ),
    );
  });

  const writeOauthSecret = (secret: VercelOauthSecret) =>
    encodeOauthSecret(secret).pipe(
      Effect.mapError((cause) => storeError("encode-secret", cause)),
      Effect.flatMap((json) => writeUtf8Secret(VERCEL_OAUTH_SECRET_NAME, json)),
    );

  const prunePending = (now: number) => {
    for (const [state, attempt] of pending) {
      if (attempt.expiresAt <= now) pending.delete(state);
    }
  };

  const hasPendingAttempt = (now: number) => {
    prunePending(now);
    return pending.size > 0;
  };

  const consumePending = (state: string, now: number): PendingAttempt | undefined => {
    prunePending(now);
    const attempt = pending.get(state);
    if (attempt === undefined) return undefined;
    pending.delete(state);
    if (attempt.expiresAt <= now) return undefined;
    return attempt;
  };

  const fetchVercel = Effect.fn("VercelAuthService.fetchVercel")(function* (
    url: string,
    init: RequestInit,
  ): Effect.fn.Return<VercelHttpResult, VercelAuthError> {
    const response = yield* Effect.tryPromise({
      try: () => globalThis.fetch(url, init),
      catch: (cause) =>
        new VercelAuthError({
          operation: "vercel-request",
          detail: "Could not reach Vercel.",
          cause,
        }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new VercelAuthError({
          operation: "vercel-request",
          detail: "Could not read the Vercel response.",
          cause,
        }),
    });
    const body =
      text.length === 0
        ? undefined
        : yield* decodeUnknownJson(text).pipe(Effect.orElseSucceed(() => undefined));
    return { ok: response.ok, status: response.status, body };
  });

  const exchangeToken = Effect.fn("VercelAuthService.exchangeToken")(function* (
    credentials: VercelAppCredentials,
    body: URLSearchParams,
  ) {
    const response = yield* fetchVercel(VERCEL_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      return yield* new VercelAuthError({
        operation: "token-exchange",
        detail: `Vercel token exchange failed (HTTP ${response.status}).`,
      });
    }
    return yield* decodeTokenResponse(response.body).pipe(
      Effect.mapError(
        (cause) =>
          new VercelAuthError({
            operation: "token-exchange",
            detail: "Vercel token exchange returned an unexpected payload.",
            cause,
          }),
      ),
    );
  });

  const persistTokens = Effect.fn("VercelAuthService.persistTokens")(function* (
    tokens: typeof VercelTokenResponse.Type,
    previous: VercelOauthSecret | undefined,
  ) {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    if (refreshToken === undefined || refreshToken.trim() === "") {
      return yield* new VercelAuthError({
        operation: "token-exchange",
        detail: "Vercel did not return a refresh token.",
      });
    }
    const accessToken = tokens.access_token.trim();
    if (accessToken === "") {
      return yield* new VercelAuthError({
        operation: "token-exchange",
        detail: "Vercel did not return an access token.",
      });
    }
    const expiresIn =
      tokens.expires_in !== undefined && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
        ? tokens.expires_in
        : DEFAULT_ACCESS_TOKEN_TTL_SEC;
    const now = yield* Clock.currentTimeMillis;
    const next: VercelOauthSecret = {
      refreshToken,
      accessToken,
      expiresAt: now + expiresIn * 1000,
      ...(previous?.accountName !== undefined ? { accountName: previous.accountName } : {}),
      ...(previous?.username !== undefined ? { username: previous.username } : {}),
      ...(previous?.teamId !== undefined ? { teamId: previous.teamId } : {}),
      ...(previous?.gatewayProvisionError !== undefined
        ? { gatewayProvisionError: previous.gatewayProvisionError }
        : {}),
    };
    yield* writeOauthSecret(next);
    return next;
  });

  const refreshIfNeeded = Effect.fn("VercelAuthService.refreshIfNeeded")(function* () {
    const existing = yield* readOauthSecret();
    if (Option.isNone(existing)) return Option.none<VercelOauthSecret>();
    const now = yield* Clock.currentTimeMillis;
    if (existing.value.expiresAt - REFRESH_SKEW_MS > now) {
      return Option.some(existing.value);
    }
    const credentials = readCredentials();
    if (credentials === undefined) {
      return yield* missingConfigError("refresh");
    }
    const tokens = yield* exchangeToken(
      credentials,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: existing.value.refreshToken,
      }),
    );
    const next = yield* persistTokens(tokens, existing.value);
    return Option.some(next);
  });

  const getValidAccessToken = Effect.fn("VercelAuthService.getValidAccessToken")(function* () {
    const secret = yield* oauthLock.withPermits(1)(refreshIfNeeded());
    return Option.map(secret, (value) => value.accessToken);
  });

  const getValidGatewayKey = Effect.fn("VercelAuthService.getValidGatewayKey")(function* () {
    return yield* readUtf8Secret(VERCEL_GATEWAY_KEY_SECRET_NAME);
  });

  const getValidApiToken = Effect.fn("VercelAuthService.getValidApiToken")(function* () {
    return yield* readUtf8Secret(VERCEL_API_TOKEN_SECRET_NAME);
  });

  const secretFlags = Effect.fn("VercelAuthService.secretFlags")(function* () {
    const gateway = yield* readUtf8Secret(VERCEL_GATEWAY_KEY_SECRET_NAME).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const apiToken = yield* readUtf8Secret(VERCEL_API_TOKEN_SECRET_NAME).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return {
      hasGatewayKey: Option.isSome(gateway),
      hasApiToken: Option.isSome(apiToken),
    };
  });

  const statusFromOauth = (
    oauth: VercelOauthSecret | undefined,
    flags: { readonly hasGatewayKey: boolean; readonly hasApiToken: boolean },
    pendingAttempt: boolean,
  ): VercelAuthStatus => {
    if (oauth !== undefined) {
      return {
        status: "connected",
        hasGatewayKey: flags.hasGatewayKey,
        hasApiToken: flags.hasApiToken,
        ...(oauth.accountName !== undefined ? { accountName: oauth.accountName } : {}),
        ...(oauth.username !== undefined ? { username: oauth.username } : {}),
        ...(oauth.teamId !== undefined ? { teamId: oauth.teamId } : {}),
        ...(oauth.gatewayProvisionError !== undefined
          ? { error: oauth.gatewayProvisionError }
          : {}),
      };
    }
    if (pendingAttempt) {
      return {
        status: "pending",
        hasGatewayKey: flags.hasGatewayKey,
        hasApiToken: flags.hasApiToken,
      };
    }
    return {
      status: "disconnected",
      hasGatewayKey: flags.hasGatewayKey,
      hasApiToken: flags.hasApiToken,
    };
  };

  const getStatus = Effect.fn("VercelAuthService.getStatus")(function* () {
    const flags = yield* secretFlags();
    const decoded = yield* readOauthSecret().pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          error: isVercelAuthError(error) ? error.detail : "Could not read Vercel auth status.",
        }),
      ),
    );
    if (!decoded.ok) {
      return {
        status: "error" as const,
        hasGatewayKey: flags.hasGatewayKey,
        hasApiToken: flags.hasApiToken,
        error: decoded.error,
      } satisfies VercelAuthStatus;
    }
    const now = yield* Clock.currentTimeMillis;
    return statusFromOauth(Option.getOrUndefined(decoded.value), flags, hasPendingAttempt(now));
  });

  const start = Effect.fn("VercelAuthService.start")(function* () {
    if (readCredentials() === undefined) {
      return yield* missingConfigError("start");
    }
    return { authorizationUrl: VERCEL_AUTHORIZE_PATH } satisfies VercelAuthStartResult;
  });

  const revokeRefreshToken = Effect.fn("VercelAuthService.revokeRefreshToken")(function* (
    refreshToken: string,
  ) {
    const credentials = readCredentials();
    if (credentials === undefined) return;
    yield* fetchVercel(VERCEL_REVOKE_URL, {
      method: "POST",
      headers: {
        authorization: basicAuthHeader(credentials),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: refreshToken }),
    }).pipe(Effect.ignoreCause({ log: true }));
  });

  const clearStoredAuth = Effect.fn("VercelAuthService.clearStoredAuth")(function* () {
    pending.clear();
    const existing = yield* readOauthSecret().pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(existing)) {
      yield* revokeRefreshToken(existing.value.refreshToken);
    }
    yield* removeSecret(VERCEL_OAUTH_SECRET_NAME);
    yield* removeSecret(VERCEL_GATEWAY_KEY_SECRET_NAME);
    yield* removeSecret(VERCEL_API_TOKEN_SECRET_NAME);
  });

  const logout = Effect.fn("VercelAuthService.logout")(function* () {
    yield* oauthLock.withPermits(1)(clearStoredAuth());
    return yield* getStatus();
  });

  const setApiToken = Effect.fn("VercelAuthService.setApiToken")(function* (token: string) {
    yield* writeUtf8Secret(VERCEL_API_TOKEN_SECRET_NAME, token);
    return yield* getStatus();
  });

  const setGatewayKey = Effect.fn("VercelAuthService.setGatewayKey")(function* (key: string) {
    yield* writeUtf8Secret(VERCEL_GATEWAY_KEY_SECRET_NAME, key);
    yield* oauthLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* readOauthSecret();
        if (Option.isNone(existing) || existing.value.gatewayProvisionError === undefined) return;
        const { gatewayProvisionError: _omit, ...rest } = existing.value;
        yield* writeOauthSecret(rest);
      }),
    );
    return yield* getStatus();
  });

  const provisionGatewayKey = Effect.fn("VercelAuthService.provisionGatewayKey")(function* (
    accessToken: string,
    teamId: string | undefined,
  ) {
    const url =
      teamId !== undefined
        ? `${VERCEL_API_KEYS_URL}?teamId=${encodeURIComponent(teamId)}`
        : VERCEL_API_KEYS_URL;
    const requestBody = yield* encodeGatewayKeyRequest({
      purpose: "ai-gateway",
      name: GATEWAY_KEY_NAME,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new VercelAuthError({
            operation: "provision-gateway-key",
            detail: "Could not provision an AI Gateway key.",
            cause,
          }),
      ),
    );
    const response = yield* fetchVercel(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: requestBody,
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ok: false,
          status: 0,
          body: undefined,
          detail: isVercelAuthError(error)
            ? error.detail
            : "Could not provision an AI Gateway key.",
        }),
      ),
    );
    if (!response.ok) {
      const detail =
        "detail" in response && typeof response.detail === "string"
          ? response.detail
          : `Could not provision an AI Gateway key (HTTP ${response.status}).`;
      return { ok: false as const, detail };
    }
    const key = extractGatewayKey(response.body);
    if (key === undefined) {
      return {
        ok: false as const,
        detail: "Vercel did not return an AI Gateway key.",
      };
    }
    yield* writeUtf8Secret(VERCEL_GATEWAY_KEY_SECRET_NAME, key);
    return { ok: true as const };
  });

  const completeCallback = Effect.fn("VercelAuthService.completeCallback")(function* (
    code: string,
    state: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const attempt = consumePending(state, now);
    if (attempt === undefined) {
      return yield* new VercelAuthError({
        operation: "callback",
        detail: "Vercel sign-in state did not match a pending attempt.",
      });
    }
    const credentials = readCredentials();
    if (credentials === undefined) {
      return yield* missingConfigError("callback");
    }
    const tokens = yield* exchangeToken(
      credentials,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        code_verifier: attempt.codeVerifier,
        redirect_uri: attempt.redirectUri,
      }),
    );
    if (tokens.id_token === undefined) {
      return yield* new VercelAuthError({
        operation: "callback",
        detail: "Vercel did not return an ID token.",
      });
    }
    const nonce = jwtNonce(tokens.id_token);
    if (nonce !== attempt.nonce) {
      return yield* new VercelAuthError({
        operation: "callback",
        detail: "Vercel sign-in nonce did not match.",
      });
    }
    const userinfo = yield* fetchVercel(VERCEL_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }).pipe(
      Effect.orElseSucceed(
        () => ({ ok: false, status: 0, body: undefined }) satisfies VercelHttpResult,
      ),
    );
    const account = userinfo.ok ? accountFromUserinfo(userinfo.body) : {};
    const provision = yield* provisionGatewayKey(tokens.access_token, account.teamId);
    yield* oauthLock.withPermits(1)(
      persistTokens(tokens, {
        refreshToken: tokens.refresh_token ?? "",
        accessToken: tokens.access_token,
        expiresAt: 0,
        ...account,
        ...(provision.ok ? {} : { gatewayProvisionError: provision.detail }),
      }),
    );
  });

  const handleAuthorize = Effect.fn("VercelAuthService.handleAuthorize")(function* () {
    const credentials = readCredentials();
    if (credentials === undefined) {
      return jsonErrorResponse(500, MISSING_CONFIG_DETAIL);
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return jsonErrorResponse(400, "Could not determine the request origin.");
    }
    const origin = url.value.origin;
    const state = randomUrlSafe(32);
    const nonce = randomUrlSafe(32);
    const codeVerifier = randomUrlSafe(32);
    const redirectUri = `${origin}${VERCEL_CALLBACK_PATH}`;
    const now = yield* Clock.currentTimeMillis;
    pending.set(state, {
      nonce,
      codeVerifier,
      redirectUri,
      expiresAt: now + PENDING_TTL_MS,
    });
    const authorize = new URL(VERCEL_AUTHORIZE_URL);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", credentials.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("nonce", nonce);
    authorize.searchParams.set("code_challenge", s256Challenge(codeVerifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("scope", VERCEL_OAUTH_SCOPE);
    return HttpServerResponse.redirect(authorize.toString(), { status: 302 });
  });

  const handleCallback = Effect.fn("VercelAuthService.handleCallback")(
    function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = requestUrl(request);
      if (Option.isNone(url)) return settingsRedirect("error");
      if (url.value.searchParams.get("error")) return settingsRedirect("error");
      const code = url.value.searchParams.get("code");
      const state = url.value.searchParams.get("state");
      if (!code || !state) return settingsRedirect("error");
      yield* completeCallback(code, state);
      return settingsRedirect("connected");
    },
    Effect.orElseSucceed(() => settingsRedirect("error")),
  );

  const handleSignout = Effect.fn("VercelAuthService.handleSignout")(function* () {
    yield* logout().pipe(Effect.ignoreCause({ log: true }));
    return HttpServerResponse.empty({ status: 204 });
  });

  return VercelAuthService.of({
    start,
    getStatus,
    logout,
    setApiToken,
    setGatewayKey,
    getValidAccessToken,
    getValidGatewayKey,
    getValidApiToken,
    handleAuthorize,
    handleCallback,
    handleSignout,
  });
});

export const layer = Layer.effect(VercelAuthService, make);
