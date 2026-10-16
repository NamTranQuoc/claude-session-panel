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
- `/panel` closes it, or opens it again.
- Open Claude in a folder that holds several projects and each git repo gets its own entry (up to 12, found up to 3 levels deep, `node_modules` skipped).

### What each field means

- **Effort** is read from the main loop's model requests, so it shows `–` until the first request.
- **ctx** is the last response's input tokens over the model's window.
- **5h / 7d** are the percentages the API last reported, with the time left until the window resets. The API gives no token counts, so none are shown.
- **PR / CI** come from `gh pr view`. A branch with no PR falls back to its latest `gh run list` result.
- **Subagent tasks** come from the subagent's `TodoWrite` calls: `x/y tasks`, ✓ done, ▶ doing, ○ waiting. A subagent that never calls `TodoWrite` shows only its tool count and last tool call.

## Refresh rates

| Data | Every |
| --- | --- |
| Agents, model, usage | 2 s |
| `git status` per repo | 10 s |
| `gh` (PR, CI) per repo | 60 s |
| Repo discovery | 2 min |

## Develop

See `CLAUDE.md`. Quick loop:

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
