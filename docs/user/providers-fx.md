# fx

T3 Code can run [fx](https://fx.sh). fx uses your Vercel AI Gateway login, or another backend you configure with fx itself.

## Set up fx

1. Install fx on the machine that runs the T3 Code server:

   ```bash
   curl -fsSL https://fx.sh/setup.sh | bash
   ```

2. Run `fx login` in a terminal on that machine.
3. Open **Settings > Providers**, enable fx, and refresh the provider.

If `fx` is not on the server's `PATH`, set **Binary path** to the executable.

Every fx instance on the same machine shares that machine's fx login. T3 Code does not keep a separate login per instance.

## Models and backend

The model picker lists **Default** first. That option keeps the model fx is already configured to run. Other ids come from `fx models`.

fx also exposes an **Effort** control. Effort starts at Medium, and T3 Code remembers the level you pick for your next thread. T3 Code does not show fx's backend selector. To use Codex, Grok, or Vercel AI Gateway, run `fx provider` on the environment's machine.

Type `$` in the composer to list fx skills from fx's skill folders.

## Permission modes

fx offers two composer modes:

| Mode           | Behavior                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| **Supervised** | fx asks before it changes files or runs tools.                               |
| **Auto**       | fx handles routine actions itself. Anything it still asks about reaches you. |

T3 Code does not offer **Full access**, **Auto-accept edits**, or Plan mode for fx. A thread already set to one of those runs in **Supervised**. Changing the permission mode starts a new fx session for that thread. Newer fx versions save the mode a thread uses as fx's default permission mode, so fx in the terminal starts in it.

## Not supported yet

- Mid-turn steering. A message sent while fx is working interrupts and restarts the turn, as on other ACP providers.
- Plan mode.
- **Full access**.
- **Auto-accept edits**.
- Commit messages, pull request text, branch names, and thread titles. Pick another provider for those.

See [provider setup](./install.md#providers) and [Permission modes](./permission-modes.md).
