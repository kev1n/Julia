# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Multiple accounts and presets

Use a separate Claude config directory (`CLAUDE_CONFIG_DIR`) for each account or for router presets that need different Claude settings.

- **New account**: In **Settings → Providers**, add Claude, name it, and choose **Sign in to a different account**. T3 Code creates a separate login directory and continues to sign-in; pick the intended account on the sign-in page. Your existing login is unchanged, and you can finish sign-in later from that slot's provider settings.
- **Same account**: **Use this machine's existing login** adds another slot without a separate login, so signing out of it affects every slot using it. Advanced configuration sets a specific config directory, binary, or router configuration.
- **Mobile**: Tap **Add Claude account** in **Settings → Providers** and enter a name and config folder. The login itself still happens on the environment's machine.
- An empty config directory uses Claude Code's normal configuration. Use `CLAUDE_CONFIG_DIR` (not `HOME`) for the login command too, so the system keychain location stays intact.
- Existing threads can only switch between Claude instances sharing the same config directory; separate account directories stay isolated, including local conversation state.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

### Many accounts through a proxy

For more than a couple of accounts, run [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
and route one Claude instance through it with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`,
then link the instance to the hub so its usage reflects the proxy's accounts.
[Connect a CLIProxyAPI hub](./usage.md#connect-a-cliproxyapi-hub)

### Using an account on other machines

**Copy account slot to other machines** copies the account's settings and ID to connected, paired T3 servers, but not Claude's credentials; each server uses its own login directory.

During sign-in, choose **Sign in on this machine** for a local login, or **Share login with connected machines** to create a subscription token and save it on the connected servers (creating the slot if missing). Saving or clearing **Subscription token** in provider settings copies that change too. These are one-time copies: offline machines are skipped, and the result message lists which succeeded. Native mobile supports machine-local sign-in only; use web or desktop to share a token or sign in on every machine.

A shared token cannot read the account's email or plan, and its usage can be unavailable. For a full login everywhere, choose **Sign in on every machine**: it starts Claude's sign-in on each connected machine, lists them together, and takes the code from each machine's sign-in page in that machine's row. This replaces a shared token on those machines and creates the slot where it is missing.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
