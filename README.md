# claude-session-panel

A Claude Code mod that docks a panel to the right of the transcript. It keeps three things in view while you work:

| Frame | Shows |
| --- | --- |
| **MODEL** | Model, effort, context window %, 5-hour and 7-day rate limits with reset time, session cost |
| **GIT** | Every git repo under the session folder: branch, ahead/behind, changed files, PR state and review, CI result |
| **SUBAGENTS** | Each subagent: status, elapsed time, task progress, current task, last tool call |

It replaces a status line that carried the same model and usage figures.

## Install

In a Claude Code terminal session:

```
/plugin install session-panel --marketplace NamTranQuoc/claude-session-panel
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod is active at once and in every session after.

From a shell: `claude plugin install session-panel --marketplace NamTranQuoc/claude-session-panel`.

To update: `claude plugin update session-panel`, then `/reload-plugins`.

Requirements:

- `git` on the PATH.
- `gh` signed in (`gh auth login`) for PR and CI. Without it the GIT frame shows `no gh / not on GitHub`.
- A terminal at least 110 columns wide. Narrower, the pane waits undrawn. Run `/panel` to ask for it explicitly.

## Use

- The pane opens by itself when a session starts.
- The GIT frame has a **↻** button.
- The MODEL frame has two button rows. Pressing a model (`fable`, `opus`, `sonnet`, `haiku`) runs `/model <name>`; pressing an effort (`low`, `med`, `high`, `xh`, `max`) runs `/effort <level>`. The current one is highlighted. A row is hidden if the session has no such slash command. Switching model mid-session makes the next request re-bill the prompt cache.
- `/panel` closes it, or opens it again.
- Open Claude in a folder that holds several projects and each git repo gets its own entry (up to 12, found up to 3 levels deep, `node_modules` skipped).

### What each field means

- **Effort** is read from the main loop's model requests, so it shows `–` until the first request.
- **ctx** is the last response's input tokens over the model's window.
- **5h / 7d** are the percentages the API last reported, with the time left until the window resets. The API gives no token counts, so none are shown.
- **PR / CI** come from `gh pr view`. Click the PR text to open the pull request, or the CI text to open its checks page, in your default browser (`open`, falling back to `xdg-open`; only `https://` links). A branch with no PR falls back to its latest `gh run list` result.
- **Subagent tasks** come from the subagent's `TodoWrite` calls: `x/y tasks`, ✓ done, ▶ doing, ○ waiting. A subagent that never calls `TodoWrite` shows only its tool count and last tool call.

## Refresh

| Data | When |
| --- | --- |
| Agents, model, usage | Every 2 s (local calls, no network) |
| Git, PR, CI, repo list | When a session starts; after a `Bash` tool call whose command runs `git` or `gh` (3 s after it finishes); when you press **↻** in the GIT frame |

There is no polling for git or `gh`. The GIT frame shows how long ago it was read. Press **↻** (or `r` while the pane has focus) for a manual read, for example to see CI after a push.

`git` status is read locally and never runs `git fetch`, so ahead/behind reflects your last fetch.

## Develop

See `CLAUDE.md`. Quick loop:

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
