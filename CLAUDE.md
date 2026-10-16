# claude-session-panel — maintenance guide

A Claude Code mod (function hooks, not a command-hooks plugin). One module draws a docked `Pane`. Read `README.md` for what users see; this file is for changing the code.

## Files

- `hooks/register.tsx` — the whole mod: data collection, timers, rendering.
- `hooks/hooks.json` — `{ "modules": ["./register.tsx"] }`, one path.
- `.claude-plugin/plugin.json` — manifest. `marketplace.json` — makes this repo installable.
- `tests/panel.test.tsx` — mounts the pane and checks the three frames.
- `tsconfig.json` — extends the types the engine lays in `.claude-plugin/types/` (gitignored, written on load).

## How it works

- State is plain module variables (`repos`, `agents`, `model`, `effort`, `usage`). There is no `$.state` and no types contract. A reload restarts them, which is fine: everything is re-read on the next tick.
- `session.start` registers `/panel`, opens the pane (`columns: 56`), starts one timer (agents + usage, 2 s; local calls only) and calls `refreshAll()` once.
- `refreshAll` (scan repos, `git status`, `gh`) has no timer. It runs at session start, from the **↻** button in the GIT frame, and from the `tool.call` hook 3 s (debounced) after a `Bash` call whose command matches `GIT_CMD` (`git` or `gh` as a command word). `isRefreshing` stops overlap and drives the "refreshing…" label; `gitAt` drives the "Ns ago" label.
- MODEL frame pickers call `$.command.run({ command: 'model' | 'effort', args })`, i.e. the built-in slash commands, queued until the session is idle. `commands` (from `$.command.list()` at `session.start`) decides whether a row is drawn. `effort` is set optimistically on press and corrected by the next `turn.step`.
- PR and CI are `Button plain` rows. A press runs `openUrl` (`open`, else `xdg-open`, https links only). PR url comes from `gh pr view --json url`; CI url is `<pr url>/checks`, or the run's `url` when there is no PR.
- Each refresh ends with `$.ui.invalidate('ui.render')` while `isOpen`.
- `ui.render` on `{ component: 'Pane', requestId: 'session-panel' }` draws three `frame(...)` boxes in this order: MODEL, GIT, SUBAGENTS.
- Data sources:
  - model, usage: `$.session.model()`, `$.session.usage()` (context %, `rateLimits` with `five_hour` / `seven_day`, cost).
  - effort: captured from `turn.step` on the main loop (`e.agentId === undefined`).
  - agents: `$.agent.list()` plus the `tool.call` hook, which reads `e.agentId` and `TodoWrite` input.
  - git: `$.process.run(['git', '-C', dir, 'status', '--porcelain=v1', '-b'])`; PR/CI: `gh pr view --json …`, fallback `gh run list`.
  - repo discovery: `find <cwd> -maxdepth 3 -name .git`.

## Add a feature

1. Collect the data in a timer (or hook) into a module variable.
2. Draw it inside `ui.render`. Use `frame(title, color, right, rows)` for a new box; keep columns fixed-width with `padEnd` / `padStart` (see `meter`).
3. Mind the width: use `width` (pane columns − 6) and `fit(text, width)`.
4. Run the checks below. In a session with hot reload on, the pane reloads when the turn ends.

## Checks

```
claude plugin validate .
claude plugin test .
```

Type-check: the engine lays `.claude-plugin/types/` on first load; then `tsc -p .` works. Before that, use a tsconfig outside the repo that includes the API file from the plugin-authoring skill (`types/claude-code.d.ts`) and `hooks`.

Tests run with no process or network. `$.ui.mount` needs `mock.clock(on)` because the render reads `$.clock.now()`.

## Known limits

- Subagent progress needs `TodoWrite`. `TaskCreate` / `TaskUpdate` are not handled.
- Rate limits are percentages only.
- The dock needs 110+ columns (144 when opened unasked); `/panel` asks explicitly.
- `tool.call` and `ui.close` hooks have no `.catch`: if one throws it is skipped, which is acceptable for observers.
- The `gh` calls assume `gh` is signed in; each refresh costs up to two `gh` calls per repo.

## Conventions

- English for code, comments, docs and commits.
- Keep the module a single file until it passes roughly 500 lines; then split by frame (`model`, `git`, `agents`).
