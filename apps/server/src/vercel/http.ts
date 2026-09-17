import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import {
  VERCEL_AUTHORIZE_PATH,
  VERCEL_CALLBACK_PATH,
  VERCEL_SIGNOUT_PATH,
  VercelAuthService,
} from "./VercelAuthService.ts";

export const vercelAuthRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    VERCEL_AUTHORIZE_PATH,
    Effect.flatMap(VercelAuthService, (vercelAuth) => vercelAuth.handleAuthorize()),
  ),
  HttpRouter.add(
    "GET",
    VERCEL_CALLBACK_PATH,
    Effect.flatMap(VercelAuthService, (vercelAuth) => vercelAuth.handleCallback()),
  ),
  HttpRouter.add(
    "POST",
    VERCEL_SIGNOUT_PATH,
    Effect.flatMap(VercelAuthService, (vercelAuth) => vercelAuth.handleSignout()),
  ),
);
