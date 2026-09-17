# Sandboxes

When sandbox execution is on, each thread runs inside a Vercel Sandbox. The workspace is uploaded there, and the agent works on that copy. Code leaves your machine.

## Turn it on

1. Open Settings, then Providers. Sign in with Vercel in the Vercel account section.
2. Set `settings.vercelSandbox.enabled` to true. Fill in `teamId` and `projectId`.
3. Optionally set `image`. The default is `t3code-agent:latest`. Build and push that image with `node scripts/build-sandbox-image.ts`.

## Egress

Sandboxes deny outbound traffic by default. A short allowlist covers Vercel, npm, yarn, and GitHub. Calls to the AI Gateway get the real key injected at the firewall. The key never enters the sandbox.

## Lifetime

A thread sandbox lasts up to 24 hours. The session ends with the sandbox. There is no auto-resume.
