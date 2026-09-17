// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - one-shot operator script, no Effect runtime.
/**
 * Live check of the sandbox execution path against real Vercel infrastructure.
 *
 *   VERCEL_TOKEN=... VERCEL_TEAM_ID=team_... VERCEL_PROJECT_ID=prj_... \
 *   AI_GATEWAY_API_KEY=... node scripts/sandbox-smoke.ts
 *
 * Optional: T3_SANDBOX_IMAGE (default t3code-agent:latest), T3_SMOKE_MODEL
 * (default anthropic/claude-haiku-4.5).
 *
 * Creates one sandbox with the production network policy, then proves:
 *   1. egress to an unlisted host (example.com) is denied,
 *   2. the AI Gateway answers 200 with no key inside the sandbox (header injection),
 *   3. the runner boots from the image and completes a real turn through the gateway,
 * and stops the sandbox. Prints a verdict table; exit code 0 only if every row passed.
 */
import * as NodeCrypto from "node:crypto";

import { Sandbox } from "@vercel/sandbox";
import {
  decodeRunnerFrame,
  encodeHostFrame,
  FX_RUNNER_HOST_ENV,
  FX_RUNNER_PORT_ENV,
  FX_RUNNER_TOKEN_ENV,
  type RunnerFrame,
} from "@t3tools/fx-runner/protocol";

import {
  AI_GATEWAY_HOST,
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  SANDBOX_INJECTED_API_KEY,
  SANDBOX_RUNNER_ENTRYPOINT,
  SANDBOX_RUNNER_PORT,
  sandboxNetworkPolicy,
} from "@t3tools/contracts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(
      `Set VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID and AI_GATEWAY_API_KEY to run the sandbox smoke test (missing ${name}).\n`,
    );
    process.exit(2);
  }
  return value;
};

const credentials = {
  token: required("VERCEL_TOKEN"),
  teamId: required("VERCEL_TEAM_ID"),
  projectId: required("VERCEL_PROJECT_ID"),
};
const gatewayKey = required("AI_GATEWAY_API_KEY");
const image = process.env.T3_SANDBOX_IMAGE?.trim() || DEFAULT_VERCEL_SANDBOX_IMAGE;
const model = process.env.T3_SMOKE_MODEL?.trim() || "anthropic/claude-haiku-4.5";
const runnerToken = NodeCrypto.randomUUID();
const workspaceDir = "/vercel/sandbox/smoke";

interface Verdict {
  readonly check: string;
  readonly pass: boolean;
  readonly detail: string;
}
const verdicts: Verdict[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  verdicts.push({ check, pass, detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${check}: ${detail}\n`);
};

const curlStatus = async (sandbox: Sandbox, url: string, headers: ReadonlyArray<string> = []) => {
  const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20"];
  for (const header of headers) args.push("-H", header);
  args.push(url);
  const result = await sandbox.runCommand("curl", args);
  return {
    exitCode: result.exitCode,
    status: (await result.stdout()).trim(),
    stderr: (await result.stderr()).trim(),
  };
};

const waitForListening = async (logs: AsyncIterable<{ stream: string; data: string }>) => {
  let buffered = "";
  for await (const log of logs) {
    if (log.stream !== "stdout") continue;
    buffered += log.data;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.includes('"listening"')) return line;
    }
  }
  throw new Error("runner exited before announcing its port");
};

const runTurn = (url: string) =>
  new Promise<{ readonly frames: RunnerFrame[]; readonly text: string }>((resolve, reject) => {
    const frames: RunnerFrame[] = [];
    let text = "";
    const timer = setTimeout(() => reject(new Error("turn timed out after 120s")), 120_000);
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runnerToken}` } });
    const finish = (result: () => void) => {
      clearTimeout(timer);
      ws.close(1000, "smoke done");
      result();
    };
    ws.addEventListener("error", () => finish(() => reject(new Error("websocket error"))));
    ws.addEventListener("open", () => {
      ws.send(
        encodeHostFrame({
          type: "init",
          apiKey: SANDBOX_INJECTED_API_KEY,
          model,
          rootDir: workspaceDir,
        }),
      );
    });
    ws.addEventListener("message", (message) => {
      const frame = decodeRunnerFrame(String(message.data));
      frames.push(frame);
      if (frame.type === "ready") {
        ws.send(
          encodeHostFrame({
            type: "prompt",
            turnId: "smoke-turn",
            input: "Reply with exactly the single word: pong",
          }),
        );
      }
      if (frame.type === "event" && frame.event.type === "text_delta") text += frame.event.delta;
      if (frame.type === "turnResult") finish(() => resolve({ frames, text }));
      if (frame.type === "error" && frame.fatal) {
        finish(() => reject(new Error(`runner error: ${frame.message}`)));
      }
    });
  });

async function main() {
  process.stdout.write(`creating sandbox from ${image} with the production network policy\n`);
  const sandbox = await Sandbox.create({
    ...credentials,
    name: `t3-smoke-${Date.now().toString(36)}`,
    image,
    timeout: 15 * 60 * 1000,
    ports: [SANDBOX_RUNNER_PORT],
    networkPolicy: sandboxNetworkPolicy(gatewayKey),
    env: {
      [FX_RUNNER_TOKEN_ENV]: runnerToken,
      [FX_RUNNER_PORT_ENV]: String(SANDBOX_RUNNER_PORT),
      [FX_RUNNER_HOST_ENV]: "0.0.0.0",
    },
    tags: { t3code: "smoke" },
    persistent: false,
  });
  process.stdout.write(`sandbox ${sandbox.name} is ${sandbox.status}\n`);

  try {
    const denied = await curlStatus(sandbox, "https://example.com/");
    record(
      "egress to example.com denied",
      denied.exitCode !== 0 || denied.status === "000",
      `curl exit ${denied.exitCode}, http ${denied.status}${denied.stderr ? `, ${denied.stderr}` : ""}`,
    );

    const bare = await curlStatus(sandbox, `https://${AI_GATEWAY_HOST}/v1/models`);
    record(
      "gateway /v1/models answers 200 with no key in the sandbox",
      bare.status === "200",
      `http ${bare.status}`,
    );

    const placeholder = await curlStatus(sandbox, `https://${AI_GATEWAY_HOST}/v1/models`, [
      `authorization: Bearer ${SANDBOX_INJECTED_API_KEY}`,
    ]);
    record(
      "gateway replaces the runner's placeholder bearer",
      placeholder.status === "200",
      `http ${placeholder.status}`,
    );

    await sandbox.writeFiles([
      { path: `${workspaceDir}/README.md`, content: Buffer.from("# smoke\n") },
    ]);
    const runner = await sandbox.runCommand({
      cmd: "node",
      args: [SANDBOX_RUNNER_ENTRYPOINT],
      cwd: workspaceDir,
      detached: true,
    });
    const listening = await Promise.race([
      waitForListening(runner.logs()),
      runner.wait().then(async (done) => {
        throw new Error(`runner exited ${done.exitCode}: ${await done.stderr()}`);
      }),
    ]);
    record("runner boots from the image", true, listening);

    const url = sandbox.domain(SANDBOX_RUNNER_PORT).replace(/^http/, "ws");
    const turn = await runTurn(url);
    const result = turn.frames.find((frame) => frame.type === "turnResult");
    const stopReason = result?.type === "turnResult" ? result.stopReason : "none";
    record(
      `turn completes through the gateway via ${url}`,
      stopReason !== "error" && stopReason !== "none",
      `stopReason ${stopReason}, text ${JSON.stringify(turn.text.trim()).slice(0, 80)}`,
    );
    await runner.kill("SIGTERM").catch(() => undefined);
  } catch (error) {
    record("smoke run", false, error instanceof Error ? error.message : String(error));
  } finally {
    await sandbox.stop();
    process.stdout.write(`sandbox ${sandbox.name} stopped\n`);
  }

  const width = Math.max(...verdicts.map((v) => v.check.length));
  process.stdout.write("\nverdict\n");
  for (const verdict of verdicts) {
    process.stdout.write(
      `  ${verdict.pass ? "PASS" : "FAIL"}  ${verdict.check.padEnd(width)}  ${verdict.detail}\n`,
    );
  }
  process.exitCode = verdicts.every((verdict) => verdict.pass) ? 0 : 1;
}

await main();
