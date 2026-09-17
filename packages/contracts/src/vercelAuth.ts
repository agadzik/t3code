import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VercelAuthStatusKind = Schema.Literals([
  "disconnected",
  "pending",
  "connected",
  "error",
]);
export type VercelAuthStatusKind = typeof VercelAuthStatusKind.Type;

export const VercelAuthStatus = Schema.Struct({
  status: VercelAuthStatusKind,
  accountName: Schema.optionalKey(TrimmedNonEmptyString),
  username: Schema.optionalKey(TrimmedNonEmptyString),
  teamId: Schema.optionalKey(TrimmedNonEmptyString),
  hasGatewayKey: Schema.Boolean,
  hasApiToken: Schema.Boolean,
  error: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VercelAuthStatus = typeof VercelAuthStatus.Type;

export const VercelAuthStartResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString,
});
export type VercelAuthStartResult = typeof VercelAuthStartResult.Type;

export const VercelAuthSetApiTokenInput = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export type VercelAuthSetApiTokenInput = typeof VercelAuthSetApiTokenInput.Type;

export const VercelAuthSetGatewayKeyInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type VercelAuthSetGatewayKeyInput = typeof VercelAuthSetGatewayKeyInput.Type;

/** Safe Vercel auth failure text. Never include tokens, codes, or verifiers. */
export class VercelAuthError extends Schema.TaggedError<VercelAuthError>()("VercelAuthError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
