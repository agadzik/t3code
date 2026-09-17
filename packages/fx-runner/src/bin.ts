/**
 * fx runner process entrypoint: `FX_RUNNER_TOKEN=<token> node bin.ts`.
 * Prints one `{"type":"listening","port":N}` line on stdout once it accepts
 * connections, then exits when its single connection ends.
 */
// oxlint-disable-next-line typescript/triple-slash-reference -- libfx ships no types; the ambient module must reach every program that imports this file.
/// <reference path="./libfx.d.ts" />
import { createFxAgent } from "libfx/node";

import {
  encodeRunnerListening,
  FX_RUNNER_HOST_ENV,
  FX_RUNNER_PORT_ENV,
  FX_RUNNER_TOKEN_ENV,
} from "./protocol.ts";
import { startRunnerServer } from "./server.ts";

const token = process.env[FX_RUNNER_TOKEN_ENV];
if (!token) {
  process.stderr.write(`${FX_RUNNER_TOKEN_ENV} is required\n`);
  process.exit(2);
}
const host = process.env[FX_RUNNER_HOST_ENV];
const port = Number(process.env[FX_RUNNER_PORT_ENV] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`${FX_RUNNER_PORT_ENV} must be a port number\n`);
  process.exit(2);
}

const server = await startRunnerServer({
  token,
  createAgent: createFxAgent,
  ...(host ? { host } : {}),
  port,
});
process.stdout.write(`${encodeRunnerListening({ type: "listening", port: server.port })}\n`);
const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await server.finished;
process.exit(0);
