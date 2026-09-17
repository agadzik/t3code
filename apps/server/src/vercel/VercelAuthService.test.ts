// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VercelAuth from "./VercelAuthService.ts";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const StoredOauth = Schema.Struct({
  refreshToken: Schema.String,
  accessToken: Schema.String,
  expiresAt: Schema.Finite,
  accountName: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
});
const encodeStoredOauth = Schema.encodeUnknownSync(Schema.fromJsonString(StoredOauth));
const decodeStoredOauth = Schema.decodeUnknownSync(Schema.fromJsonString(StoredOauth));

let layerSeq = 0;

const withCredentials = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = {
        id: process.env.VERCEL_APP_CLIENT_ID,
        secret: process.env.VERCEL_APP_CLIENT_SECRET,
        fetch: globalThis.fetch,
      };
      process.env.VERCEL_APP_CLIENT_ID = CLIENT_ID;
      process.env.VERCEL_APP_CLIENT_SECRET = CLIENT_SECRET;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.id === undefined) delete process.env.VERCEL_APP_CLIENT_ID;
        else process.env.VERCEL_APP_CLIENT_ID = previous.id;
        if (previous.secret === undefined) delete process.env.VERCEL_APP_CLIENT_SECRET;
        else process.env.VERCEL_APP_CLIENT_SECRET = previous.secret;
        globalThis.fetch = previous.fetch;
      }),
  );

const makeServiceLayer = () => {
  layerSeq += 1;
  const configLayer = Layer.fresh(
    ServerConfig.layerTest(process.cwd(), {
      prefix: `t3-vercel-auth-test-${layerSeq}-`,
    }),
  );
  const secretsLayer = ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer));
  return Layer.mergeAll(VercelAuth.layer.pipe(Layer.provide(secretsLayer)), secretsLayer);
};

const makeIdToken = (nonce: string) => {
  const header = Buffer.from(encodeJson({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(encodeJson({ nonce })).toString("base64url");
  return `${header}.${payload}.sig`;
};

const s256 = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest().toString("base64url");

const requestBody = (init?: RequestInit): string => {
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (typeof init?.body === "string") return init.body;
  return "";
};

const handle = (method: "handleAuthorize" | "handleCallback", url: string) =>
  Effect.gen(function* () {
    const vercelAuth = yield* VercelAuth.VercelAuthService;
    return yield* vercelAuth[method]().pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(url)),
      ),
    );
  });

const locationUrl = (response: HttpServerResponse.HttpServerResponse) => {
  const location = response.headers.location;
  if (typeof location !== "string" || location.length === 0) {
    throw new Error("expected a location header");
  }
  return new URL(location, "http://127.0.0.1");
};

it.layer(NodeServices.layer)("Vercel auth", (it) => {
  it.effect("authorize redirects to Vercel with an S256 challenge and pending status", () =>
    withCredentials(
      Effect.gen(function* () {
        const vercelAuth = yield* VercelAuth.VercelAuthService;
        const response = yield* handle(
          "handleAuthorize",
          "http://localhost/api/auth/vercel/authorize",
        );
        expect(response.status).toBe(302);
        const authorize = locationUrl(response);
        expect(authorize.origin).toBe("https://vercel.com");
        expect(authorize.pathname).toBe("/oauth/authorize");
        expect(authorize.searchParams.get("response_type")).toBe("code");
        expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
        expect(authorize.searchParams.get("redirect_uri")).toBe(
          "http://localhost/api/auth/vercel/callback",
        );
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.searchParams.get("scope")).toBe("openid email profile offline_access");
        expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(authorize.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(yield* vercelAuth.getStatus()).toEqual({
          status: "pending",
          hasGatewayKey: false,
          hasApiToken: false,
        });
      }).pipe(Effect.provide(makeServiceLayer())),
    ),
  );

  it.effect("callback rejects a state mismatch", () =>
    withCredentials(
      Effect.gen(function* () {
        const vercelAuth = yield* VercelAuth.VercelAuthService;
        const authorizeResponse = yield* handle(
          "handleAuthorize",
          "http://localhost/api/auth/vercel/authorize",
        );
        expect(authorizeResponse.status).toBe(302);
        const callback = yield* handle(
          "handleCallback",
          "http://localhost/api/auth/vercel/callback?code=test-code&state=not-the-state",
        );
        expect(callback.status).toBe(302);
        expect(locationUrl(callback).pathname + locationUrl(callback).search).toBe(
          "/settings/providers?vercel=error",
        );
        expect(yield* vercelAuth.getStatus()).toEqual({
          status: "pending",
          hasGatewayKey: false,
          hasApiToken: false,
        });
      }).pipe(Effect.provide(makeServiceLayer())),
    ),
  );

  it.effect("callback stores secrets and reports connected when Vercel replies", () =>
    withCredentials(
      Effect.gen(function* () {
        const vercelAuth = yield* VercelAuth.VercelAuthService;
        const authorizeResponse = yield* handle(
          "handleAuthorize",
          "http://localhost/api/auth/vercel/authorize",
        );
        const authorize = locationUrl(authorizeResponse);
        const state = authorize.searchParams.get("state") ?? "";
        const nonce = authorize.searchParams.get("nonce") ?? "";
        const challenge = authorize.searchParams.get("code_challenge") ?? "";
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const tokenBodies: string[] = [];
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          const body = requestBody(init);
          if (url === "https://api.vercel.com/login/oauth/token") {
            tokenBodies.push(body);
            return new Response(
              encodeJson({
                access_token: "access-1",
                refresh_token: "refresh-1",
                expires_in: 3600,
                id_token: makeIdToken(nonce),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url === "https://api.vercel.com/login/oauth/userinfo") {
            return new Response(
              encodeJson({
                name: "Ada Lovelace",
                preferred_username: "ada",
                team_id: "team_123",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.startsWith("https://api.vercel.com/v1/api-keys")) {
            expect(url).toContain("teamId=team_123");
            return new Response(encodeJson({ key: "gw-key-1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("not found", { status: 404 });
        };

        const callback = yield* handle(
          "handleCallback",
          `http://localhost/api/auth/vercel/callback?code=test-code&state=${encodeURIComponent(state)}`,
        );
        expect(callback.status).toBe(302);
        expect(locationUrl(callback).searchParams.get("vercel")).toBe("connected");
        const tokenParams = new URLSearchParams(tokenBodies[0] ?? "");
        expect(tokenParams.get("grant_type")).toBe("authorization_code");
        expect(tokenParams.get("code")).toBe("test-code");
        expect(s256(tokenParams.get("code_verifier") ?? "")).toBe(challenge);
        expect(yield* vercelAuth.getStatus()).toEqual({
          status: "connected",
          accountName: "Ada Lovelace",
          username: "ada",
          teamId: "team_123",
          hasGatewayKey: true,
          hasApiToken: false,
        });
        expect(Option.getOrUndefined(yield* vercelAuth.getValidGatewayKey())).toBe("gw-key-1");
      }).pipe(Effect.provide(makeServiceLayer())),
    ),
  );

  it.effect("refresh rotates the refresh token and persists it", () =>
    withCredentials(
      Effect.gen(function* () {
        const vercelAuth = yield* VercelAuth.VercelAuthService;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const now = yield* Clock.currentTimeMillis;
        yield* secretStore.set(
          VercelAuth.VERCEL_OAUTH_SECRET_NAME,
          new TextEncoder().encode(
            encodeStoredOauth({
              refreshToken: "refresh-old",
              accessToken: "access-old",
              expiresAt: now - 1000,
              accountName: "Ada Lovelace",
              username: "ada",
            }),
          ),
        );
        let refreshCalls = 0;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          const body = requestBody(init);
          if (url === "https://api.vercel.com/login/oauth/token") {
            refreshCalls += 1;
            const params = new URLSearchParams(body);
            expect(params.get("grant_type")).toBe("refresh_token");
            expect(params.get("refresh_token")).toBe("refresh-old");
            return new Response(
              encodeJson({
                access_token: "access-2",
                refresh_token: "refresh-2",
                expires_in: 3600,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        };
        expect(Option.getOrUndefined(yield* vercelAuth.getValidAccessToken())).toBe("access-2");
        expect(refreshCalls).toBe(1);
        expect(Option.getOrUndefined(yield* vercelAuth.getValidAccessToken())).toBe("access-2");
        expect(refreshCalls).toBe(1);
        const stored = Option.getOrUndefined(
          yield* secretStore.get(VercelAuth.VERCEL_OAUTH_SECRET_NAME),
        );
        assert.isTrue(stored !== undefined);
        const parsed = decodeStoredOauth(new TextDecoder().decode(stored));
        expect(parsed.refreshToken).toBe("refresh-2");
        expect(parsed.accessToken).toBe("access-2");
        expect(parsed.accountName).toBe("Ada Lovelace");
      }).pipe(Effect.provide(makeServiceLayer())),
    ),
  );

  it.effect("logout revokes the refresh token and clears stored credentials", () =>
    withCredentials(
      Effect.gen(function* () {
        const vercelAuth = yield* VercelAuth.VercelAuthService;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const now = yield* Clock.currentTimeMillis;
        yield* secretStore.set(
          VercelAuth.VERCEL_OAUTH_SECRET_NAME,
          new TextEncoder().encode(
            encodeStoredOauth({
              refreshToken: "refresh-keep",
              accessToken: "access-keep",
              expiresAt: now + 60_000,
            }),
          ),
        );
        yield* secretStore.set(
          VercelAuth.VERCEL_GATEWAY_KEY_SECRET_NAME,
          new TextEncoder().encode("gw-key-1"),
        );
        yield* secretStore.set(
          VercelAuth.VERCEL_API_TOKEN_SECRET_NAME,
          new TextEncoder().encode("api-token-1"),
        );
        const revoked: string[] = [];
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          const body = requestBody(init);
          if (url === "https://api.vercel.com/login/oauth/token/revoke") {
            revoked.push(body);
            return new Response(null, { status: 200 });
          }
          return new Response("not found", { status: 404 });
        };
        expect(yield* vercelAuth.logout()).toEqual({
          status: "disconnected",
          hasGatewayKey: false,
          hasApiToken: false,
        });
        const revokeParams = new URLSearchParams(revoked[0] ?? "");
        expect(revokeParams.get("token")).toBe("refresh-keep");
        expect(Option.isNone(yield* secretStore.get(VercelAuth.VERCEL_OAUTH_SECRET_NAME))).toBe(
          true,
        );
        expect(Option.isNone(yield* vercelAuth.getValidGatewayKey())).toBe(true);
      }).pipe(Effect.provide(makeServiceLayer())),
    ),
  );
});
