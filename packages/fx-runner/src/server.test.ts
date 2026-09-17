import { describe, expect, it } from "vite-plus/test";

import {
  decodeRunnerFrame,
  encodeHostFrame,
  type HostFrame,
  type RunnerFrame,
} from "./protocol.ts";
import { startRunnerServer } from "./server.ts";
import { makeFakeFx } from "./testing/fakeFx.ts";

const TOKEN = "test-token";

function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const received: RunnerFrame[] = [];
  const waiters: Array<(frame: RunnerFrame) => void> = [];
  ws.addEventListener("message", (message) => {
    const frame = decodeRunnerFrame(String(message.data));
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else received.push(frame);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket connection failed")), {
      once: true,
    });
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  const next = () =>
    received.length > 0
      ? Promise.resolve(received.shift()!)
      : new Promise<RunnerFrame>((resolve) => waiters.push(resolve));
  const send = (frame: HostFrame) => ws.send(encodeHostFrame(frame));
  return { ws, opened, closed, next, send };
}

describe("runner server", () => {
  it("rejects connections without the bearer token", async () => {
    const server = await startRunnerServer({
      token: TOKEN,
      createAgent: makeFakeFx(() => []).createAgent,
    });
    try {
      const client = connect(server.port, "wrong");
      await expect(client.opened).rejects.toThrow("websocket connection failed");
    } finally {
      await server.close();
    }
  });

  it("serves one connection end to end and exits when the host closes it", async () => {
    const fx = makeFakeFx(() => [{ kind: "text", delta: "hi" }]);
    const server = await startRunnerServer({ token: TOKEN, createAgent: fx.createAgent });
    const client = connect(server.port, TOKEN);
    await client.opened;

    const second = connect(server.port, TOKEN);
    await expect(second.opened).rejects.toThrow("websocket connection failed");

    client.send({ type: "init", apiKey: "key", rootDir: process.cwd() });
    expect(await client.next()).toEqual({ type: "ready" });
    client.send({ type: "prompt", turnId: "turn-1", input: "say hi" });
    expect(await client.next()).toEqual({
      type: "event",
      turnId: "turn-1",
      event: { type: "text_delta", delta: "hi" },
    });
    const result = await client.next();
    expect(result.type).toBe("turnResult");
    expect(result.type === "turnResult" && result.stopReason).toBe("end_turn");

    client.ws.send("{not json");
    const error = await client.next();
    expect(error.type).toBe("error");

    client.send({ type: "close" });
    expect(await client.closed).toBe(1000);
    await server.finished;
    expect(fx.closed()).toBe(1);
  });
});
