// @effect-diagnostics nodeBuiltinImport:off - the runner is a plain Node process that runs outside the Effect runtime.
/**
 * fx runner WebSocket server.
 *
 * Listens on an ephemeral loopback port and serves exactly one
 * bearer-authenticated connection. `finished` resolves when that connection
 * ends or the host sends `close`; `bin.ts` exits the process on it.
 */
import * as NodeHttp from "node:http";

import type { CreateFxAgentOptions, FxAgent } from "libfx/node";
import { WebSocketServer, type WebSocket } from "ws";

import { decodeHostFrame, encodeRunnerFrame, type RunnerFrame } from "./protocol.ts";
import { makeRunnerService } from "./runnerService.ts";
import { makeCodingTools } from "./tools/index.ts";

export interface RunnerServerOptions {
  readonly token: string;
  readonly createAgent: (options: CreateFxAgentOptions) => Promise<FxAgent>;
  readonly host?: string;
}

export interface RunnerServer {
  readonly port: number;
  /** Resolves when the single connection has ended and the agent is closed. */
  readonly finished: Promise<void>;
  readonly close: () => Promise<void>;
}

export async function startRunnerServer(options: RunnerServerOptions): Promise<RunnerServer> {
  const host = options.host ?? "127.0.0.1";
  const httpServer = NodeHttp.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let connected = false;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const authorized = request.headers.authorization === `Bearer ${options.token}`;
    if (!authorized || connected) {
      socket.write(
        authorized
          ? "HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    connected = true;
    wss.handleUpgrade(request, socket, head, (ws) => serveConnection(ws));
  });

  const serveConnection = (ws: WebSocket) => {
    const send = (frame: RunnerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeRunnerFrame(frame));
    };
    const service = makeRunnerService({
      createAgent: options.createAgent,
      makeTools: makeCodingTools,
      send,
    });
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await service.close();
      if (ws.readyState === ws.OPEN) ws.close(1000, "runner closed");
      await closeServer();
      finish();
    };
    ws.on("message", (data) => {
      let frame;
      try {
        frame = decodeHostFrame(data.toString());
      } catch (error) {
        send({
          type: "error",
          message: `Malformed host frame: ${error instanceof Error ? error.message : String(error)}`,
          fatal: false,
        });
        return;
      }
      void service.handle(frame).then(() => {
        if (frame.type === "close") return shutdown();
      });
    });
    ws.on("close", () => void shutdown());
    ws.on("error", () => void shutdown());
  };

  const closeServer = () =>
    new Promise<void>((resolve) => {
      wss.close();
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, host, () => {
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("runner server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    finished,
    close: async () => {
      await closeServer();
      finish();
    },
  };
}
