# fx

T3 Code can run [fx](https://fx.sh). fx uses your Vercel AI Gateway login, or another backend you configure with fx itself.

## Set up fx

1. Install fx on the machine that runs the T3 Code server:

   ```bash
   curl https://fx.sh/setup.sh | sh
   ```

2. Run `fx login` in a terminal on that machine.
3. Open **Settings > Providers**, enable fx, and refresh the provider.

If `fx` is not on the server's `PATH`, set **Binary path** to the executable.

Every fx instance on the same machine shares that machine's fx login. T3 Code does not keep a separate login per instance.

## Models and backend

The model picker lists **Default** first. That option keeps the model fx is already configured to run. Other ids come from `fx models`.

fx also exposes an **Effort** control. T3 Code does not show fx's backend selector. To use Codex, Grok, or Vercel AI Gateway, run `fx provider` on the environment's machine.

## Permission modes

fx offers three composer modes:

| Mode | Behavior |
| --- | --- |
| **Supervised** | fx asks before it changes files or runs tools. |
| **Auto-accept edits** | T3 Code allows file edits and still asks for other actions. |
| **Auto** | fx runs with its own `code` policy. Anything it still asks about reaches you. |

fx does not offer **Full access** or Plan mode. Changing the permission mode starts a new fx session for that thread.

## Not supported yet

- Mid-turn steering. A message sent while fx is working interrupts and restarts the turn, as on other ACP providers.
- Plan mode.
- **Full access**.
- Commit messages, pull request text, branch names, and thread titles. Pick another provider for those.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
