# claude-session-panel

A Claude Code mod that docks a panel to the right of the transcript, with four tabs:

| Tab | Holds |
| --- | --- |
| **Overview** | MODEL (model, effort, context %, 5-hour and 7-day rate limits, cost), GIT (each repo's branch, changes, PR, CI) and SUBAGENTS (each subagent's progress, plus the model and effort new subagents get) |
| **Explain** | Side chats about the session: ask as many follow-up questions as you like; answers are brief and nothing is ever run or changed |
| **Decisions** | The numbered questions (D1, D2, …) the main agent needs you to settle; answer them and submit the answers back |
| **Know** | Notes a side check finds worth knowing during long tasks (a decision you may have missed, a cost, a constraint); off until you turn it on |

It also gives the main agent its working rules: questions go to Decisions, and work goes to subagents only when you decide to delegate it.

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
- Answering in the pane needs a text input: terminal, desktop and VS Code have one; on mobile the pane is read-only.

## Use

- The pane opens by itself when an interactive session starts. `/panel` closes it, or opens it again.
- The tab bar on top switches tabs. `Explain 2`, `Decisions 3` and `Know 1` count open chats, open decisions and unanswered notes.

### Overview

- The MODEL frame shows the model and the effort as two dropdowns. Press one to list its options (models `fable`, `opus`, `sonnet`, `haiku`; efforts `low` to `max`), press an option to pick it, or press the dropdown again to close the list. A pick changes the setting at once, even while Claude is working; the next request uses it. Nothing is posted to the chat and there is no confirm prompt. Switching model mid-session makes the next request re-bill the prompt cache.
- The SUBAGENTS frame has the same two dropdowns for subagents (`inherit` leaves the choice to Claude Code). A pick applies to subagents started after it:
  - A model or effort you ask for in your prompt wins over the pick.
  - Forks always run on the main session's model and effort.
  - The picks are saved: a new session starts with the last ones.
- The GIT frame has a **↻** button.
- Open Claude in a folder that holds several projects and each git repo gets its own entry (up to 12: the folder itself and its direct children). A session started in your home folder or `/` is not scanned.

### Explain

- **+** opens a chat; **x** closes the selected one and deletes its history. Several chats can be open; each keeps its own history.
- Each question works like `/btw`: it is answered over the main session's latest request (read from the prompt cache, so it is cheap while that cache is warm), with the chat's recent questions and answers (up to 20, and about 6,000 characters, newest kept), in a condensed `/brief` style. Tools are refused, so a chat never acts.
- Under each answer: its tokens (`in`, `cached`, `written`, `out`). When the main session's cache was cold, a warning says how many tokens of its context were re-sent at full price.
- When the main session has been idle 5 minutes or more, its cache has likely expired: the first **Ask** only warns how many tokens the question would re-send at full price; ask again to send it.
- Answers come from the main session's model and arrive whole, not streamed.
- `No context yet` means the main session has not sent a request yet, or was cleared.
- `D3` in a question names that decision.

### Decisions

- The main agent adds, changes and removes items with its `decisions` tool. Each has a title, a detail and zero or more options. Subagents cannot change the list.
- Press an item to show its detail, its options (`1.`, `2.`, …) and an answer field, several lines tall so a long answer stays readable. Type an option number, free text, or both, and press Enter to save: `●` marks an answered item.
- **Submit** sends every saved answer to the main agent as one prompt (`D3: option 2. your text`: an option goes by its number, never its text). Each answered decision rides along as text the assistant wrote, so `option 2` still reads after the conversation is compacted. Sent items show `↑` until the agent updates or removes them.
- While the main agent is working, answering and Submit are locked; the list and details stay readable.
- `D3` in your own prompt attaches that decision for the main agent, marked as text the assistant wrote. `D3.js` or `AD3` is not a mention.

### Know

- **[checks off]** / **[checks on]** at the top turns the checks on or off; the choice is saved for the next sessions. Off by default.
- While a check is on and the pane is open (any tab), a side check runs on the 6th, 12th, 18th … step of a long turn: one `$.model.fork` over the main session, asked whether there is one thing you should know and likely missed. Most checks find nothing. Turns shorter than 6 steps are never checked.
- A note shows as `✦ K1  Heads up · <line>`. Press it for its explanation and these answers:
  - **Understood** / **Knew this already**: the note leaves, and later checks skip that topic.
  - **Not relevant** / **Dismiss**: the note leaves.
  - **Couldn't understand**: the explanation is rewritten in plainer words (one more fork).
  - **Explain**: shown instead when the check wrote no explanation (one more fork).
  - Type a reply in the field, Enter to save it, then **Submit**: the note, quoted, and your reply go into the prompt box for you to send. With text already in the prompt box, nothing is replaced; send or clear it first.
- At most 3 unanswered notes; at 3, checks stop. One note per turn; a line already offered or known is not offered again.
- A note you have seen (the Know tab was open) and passed by with 2 prompts is dropped as ignored. Three or more ignored in a row make the next checks skip: 1, then 2, 4, 8, up to 16. Any answer resets that.
- Under the toggle: the last check's outcome and its tokens (`in`, `cached`, `written`, `out`).
- Cost: each check reads the main session's cached context and pays the check's rules (about 1,400 tokens, plus up to 100 lines of topics to skip) and its output at full price. On Opus 5.5 that is roughly $0.04-0.07 a check at 100k tokens of context, $0.08-0.11 at 300k: about +10-25% on a long turn. On a Pro or Max plan it counts against the usage limits instead.
- Uninstall Claude Code's built-in *You should know* plugin when using this tab: both would check the same session.

### Working rules for the main agent

The panel adds a fixed section to the system prompt of every session with a terminal (not `-p` or SDK runs, which have no panel):

- Questions that need your choice go to Decisions.
- The main agent implements the work itself by default.
- It splits the work into tasks for subagents only when you decide to delegate it.

### What each field means

- **Effort** is read from the main loop's model requests, so it shows `–` until the first request.
- **ctx** is the last response's input tokens over the model's window.
- **5h / 7d** are the percentages the API last reported, with the time left until the window resets. The API gives no token counts, so none are shown.
- **session** is what the session has cost, as `/cost` totals it, with `i/o`: the input and output tokens of the session's own requests, main loop and subagents (input counts cached and uncached).
- **pane** is what the panel's own requests used (Explain questions, Know checks and explanations): `~$` estimated from list prices (Fable 5.1, Opus 5.5, Sonnet 5.5; another model shows `–`) and `i/o` tokens. Decisions makes no request of its own: its tool calls and Submit are part of the session. The two lines keep fixed columns so they compare at a glance, and both start over after `/clear`.
- **PR / CI** come from `gh pr view`. Click the PR text to open the pull request, or the CI text to open its checks page, in your default browser (`open`, falling back to `xdg-open`; only `https://` links). CI is shown only for an open PR; a branch with no PR shows `no PR` and no CI.
- **Subagent tasks** come from the subagent's `TodoWrite` calls: `x/y tasks`, ✓ done, ▶ doing, ○ waiting. A subagent that never calls `TodoWrite` shows only its tool count and last tool call, with tokens, passwords and API keys in it masked.

## Refresh

| Data | When |
| --- | --- |
| Agents, model, usage | Every 2 s while Overview shows (local calls, no network); hidden, only agents, while one runs |
| Repo list | When an interactive session starts; when you press **↻** |
| Git status of one repo | 3 s after a `Bash` call runs `git` or `gh` in that repo (repos outside the session folder are skipped) |
| PR and CI of one repo | Same trigger, only for a command that can change them (`git push`, `checkout`, `switch`; `gh pr create`, `merge`, `close`, `reopen`, `ready`, `edit`, `checkout`; `gh run rerun`; `gh workflow run`), at most once a minute per repo, and not for a repo `gh` could not read |
| Everything, every repo | When an interactive session starts; when you press **↻** (no one-minute limit). A `-p` or SDK run reads no git or `gh`. |

There is no polling for git or `gh`; one refresh costs one `gh pr view` per repo it reads. The GIT frame shows how long ago it was read. Press **↻** (or `r` while the pane has focus) for a manual read, for example to see CI after a push.

`git` status is read locally and never runs `git fetch`, so ahead/behind reflects your last fetch.

## Develop

See `CLAUDE.md`. Quick loop:

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT. See [LICENSE](LICENSE).
