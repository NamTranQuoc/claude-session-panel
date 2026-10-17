# claude-session-panel — maintenance guide

A Claude Code mod (function hooks, not a command-hooks plugin). One hooks module draws a docked `Pane` with three tabs and gives the main agent its working rules. Read `README.md` for what users see; this file is for changing the code.

## Files

- `hooks/hooks.json` — `{ "modules": ["./register.tsx"] }`, one path.
- `hooks/register.tsx` — entry: the tab bar (outermost Pane hook), `session.start` for interactive sessions (`/panel`, the `decisions` tool, opening the pane), `/panel`, `prompt.compose`, `turn.start`, `turn.complete`; then calls each `registerX(on)`.
- `hooks/overview.tsx` — Overview tab: MODEL, GIT, SUBAGENTS frames, their timers and data (`session.start`, `tool.call`, `classic.PreModelSwitch`).
- `hooks/explain.tsx` — Explain tab: chats and `$.model.fork` calls.
- `hooks/decisions.tsx` — Decisions tab, the `decisions` tool's `tool.call`, `D<n>` mentions on `prompt.submit`.
- `hooks/subagents.ts` — subagent model/effort picks: `agent.spawn`, `turn.step`.
- `hooks/system.ts` — the fixed system prompt section (`RULES`).
- `hooks/brief.ts` — the `/brief` rules for explain answers, with a fallback.
- `hooks/shared.ts` — constants, `live` (what hooks learn as the session runs), text helpers.
- `types/index.d.ts` — the `$.state` contract (`PluginState['session-panel']`) and its value types.
- `.claude-plugin/plugin.json` — manifest. `marketplace.json` — makes this repo installable.
- `tests/` — `panel.test.tsx` (the Overview frames), `tabs.test.tsx` (tabs, chats, decisions, rules, subagent picks).
- `tsconfig.json` — extends the types the engine lays in `.claude-plugin/types/` (gitignored, written on load).

## Rules the validator enforces

`claude plugin validate .` refuses a module that breaks these, and the module then does not load:

- `on` is only ever called as `on('<event>', …)`. Passing `on` to a function that registers is fine (`registerOverview(on)` as a statement); keeping a registration's value is not.
- An event without a matcher is registered once per plugin. Events with a matcher (`ui.render` on the Pane, `tool.call` on the `decisions` tool) may repeat.
- `$` is only spelled `$.noun.event(...)`; it is never passed to a function of ours. Helpers take plain values; anything that calls `$` lives inside a hook body (closures there may call `$`).
- `read` / `update` take an `atom` defined with literal `plugin` and `key` in the same file. Each file declares the atoms it uses; the same key in two files is the same value.

## How it works

- **Pane.** The Pane's `ui.render` hooks nest in registration order. `register.tsx` registers first, so its hook is outermost: it draws the tab bar and `next(e)` below it. Each tab's hook returns its body when `tab` is its own, else `next(e)`.
- **State.**
  - `$.state` (atoms) holds `tab`, `chats`, `chatId`, `nextChatId`, `decisions`, `decisionId`, `nextDecisionId`, `agentModel`, `agentEffort`. A hot reload keeps them; a new session starts empty. `update` redraws the readers.
  - Module variables hold the rest (`repos`, `agents`, `usage`, `live`, the subagent effort map); a reload restarts them and the next tick or event refills them.
- **Overview.**
  - `session.start` starts one timer (agents + usage, 2 s; local calls only) and calls `refreshAll()` once.
  - `refreshAll` (scan repos, `git status`, `gh`) has no timer. It runs at session start, from **↻**, and 3 s (debounced) after a `Bash` call matching `GIT_CMD`. `isRefreshing` stops overlap; `gitAt` drives the "Ns ago" label.
  - MODEL dropdowns write the `/config` rows with `$.config.set` (rows found at `session.start`, `settings`), falling back to `$.command.run` (`/model`, `/effort`, queued until idle). `classic.PreModelSwitch` answers `allow` while `live.isSwitching`. A dropdown opens only when `settings` or `commands` has it.
  - SUBAGENTS dropdowns write `agentModel` / `agentEffort` (`inherit` by default).
  - PR and CI rows open their https URL with `open`, else `xdg-open`.
- **Subagent picks.** `agent.spawn` skips forks, teammates, workflow agents and resumes. Otherwise:
  - model: the call's `model` if set, else the pick unless `inherit`.
  - effort: a leading `effort: <level>` line in the prompt (removed before the spawn), else the pick unless `inherit`; recorded per `agentId`. `turn.step` rewrites `effort` on that agent's requests; `turn.complete` drops the record.
  - `turn.step` on the main loop records `live.model` / `live.effort`.
- **Explain.**
  - `+` adds a chat, `x` deletes it. A chat is `{ id, history, draft, isAsking, notice }`.
  - A question: `$.model.fork({ prompt })`, `prompt` from `explainPrompt` (rules + `/brief` rules + `listDecisions` + the last 20 turns + the question). The `/brief` rules are read once with `$.env.get('HOME')` and `$.fs.read`.
  - Not answered → `notice`, and the question goes back into `draft`. A chat closed while asking drops the reply.
- **Decisions.**
  - The tool `mcp__session-panel__decisions` (registered with `isDeferred: false`) takes `{ upsert?, remove? }`; `applyDecisions` removes, then upserts. An upsert without `id`, or with an unknown one, takes `nextDecisionId`, so a number is never reused. Replacing an item clears its answer. The result lists the open items.
  - A selected item that disappears is deselected.
  - `live.isMainRunning` (`turn.start` / `turn.complete` on the main loop) hides the answer `Input` and **Submit**.
  - Submit sends the saved answers through `$.prompt.submit` (`formatAnswer` names a leading option number) and stamps `sentAt`.
  - `prompt.submit` attaches the items a prompt names as `D<n>` as `context`.
- **System prompt.** `prompt.compose` appends the section `session-panel:rules` (`RULES`, fixed text) with scope `session`, except for teammate and `--bare` prompts. Its text never changes mid-session, so it never moves the prompt cache.

## Add a feature

1. Data from a timer or hook goes into a module variable, or an atom when the pane draws it and it should survive a reload.
2. Draw it inside the owning tab's `ui.render` hook. Overview boxes use `frame(title, color, right, rows)`; keep columns fixed-width with `padEnd` / `padStart` (see `meter`).
3. Mind the width: `width` (pane columns − 6) and `fit(text, width)`.
4. Keep to the validator's rules above, then run the checks below. In a session with hot reload on, the pane reloads when the turn ends.

## Checks

```
claude plugin validate .
claude plugin test .
```

Type-check: the engine lays `.claude-plugin/types/` on first load; then `tsc -p .` works. Before that, use a tsconfig outside the repo that includes the API file from the plugin-authoring skill (`types/claude-code.d.ts`), `hooks`, `types` and `tests`.

Tests run with no process or network. `$.ui.mount` needs `mock.clock(on)` because the render reads `$.clock.now()`. A test's own `on(...)` hooks (the bottom of a chain) are registered before its first `$` call.

## Known limits

- Subagent progress needs `TodoWrite`. `TaskCreate` / `TaskUpdate` are not handled.
- A subagent's effort is recorded when `agent.spawn` resolves; a request the subagent sends before that runs at the engine's effort.
- Explain answers run on the main session's model; `$.model.fork` takes no model or effort.
- Rate limits are percentages only.
- The dock needs 110+ columns (144 when opened unasked); `/panel` asks explicitly.
- The `tool.call`, `prompt.submit`, `agent.spawn` and `classic.PreModelSwitch` hooks have no `.catch`: one that throws is skipped and the call goes on as it was; the `decisions` tool then has no answer and its call fails.
- Where an organization manages Claude Code, `prompt.compose` and `classic.PreModelSwitch` do not reach an installed plugin: the rules section and the no-prompt model switch are then absent.
- The `gh` calls assume `gh` is signed in; each refresh costs up to two `gh` calls per repo.

## Conventions

- English for code, comments, docs and commits.
- One file per tab or concern; a file past roughly 500 lines splits by frame.
