import { atom, read, update } from 'claude-code'
import type { ConfigRow, On, RenderChildren, SessionUsage } from 'claude-code'

import type { SessionPanelSpending, SessionPanelTab } from '../types'
import { ago, bar, clock, commandDir, level, parseCi, repoOf, TERMINAL, toolSummary, until } from './overview-data'
import type { AgentView, Picker, Repo, Todo } from './overview-data'
import { EFFORTS, fit, INHERIT, live, MODELS, NO_SPENDING, PANE, paneSpend, spendingSince, tokens } from './shared'
import type { CacheTtl } from './shared'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const agentModel = atom({ plugin: 'session-panel', key: 'agentModel' } as const, 'inherit')
const agentEffort = atom({ plugin: 'session-panel', key: 'agentEffort' } as const, 'inherit')
const spend = atom({ plugin: 'session-panel', key: 'spend' } as const, NO_SPENDING as SessionPanelSpending)
const cacheTtl = atom({ plugin: 'session-panel', key: 'cacheTtl' } as const, '' as CacheTtl | '')

const FAST_MS = 2000
const GIT_CMD = /(^|[\s;&|(])(git|gh)\s/
// Commands that can change what GitHub shows for the branch: its PR and checks. A push or a branch
// change, or a gh call that writes; local commits and gh reads do not.
const REMOTE_CMD = /(^|[\s;&|(])(git\s+(-C\s+\S+\s+)?(push|checkout|switch)\b|gh\s+(pr\s+(create|merge|close|reopen|ready|edit|checkout)|run\s+rerun|workflow\s+run)\b)/
const GH_GAP_MS = 60000
const MAX_REPOS = 12
const MAX_AGENTS = 8

// The Overview tab: MODEL, GIT and SUBAGENTS frames, and the data behind them.
export const registerOverview = (on: On) => {
  let repos: Repo[] = []
  const agents = new Map<string, AgentView>()
  const timers: { cancel: () => void }[] = []
  let usage: SessionUsage | undefined
  let isRefreshing = false
  // The session started in the home folder or `/`: no scan there.
  let isScanSkipped = false
  let gitAt = 0
  let refreshAll: (() => void) | undefined
  let refreshRepo: (() => void) | undefined
  // Repos a git/gh call touched since the last auto refresh, and whether it asks for gh.
  const pending = new Map<string, boolean>()
  let commands = new Set<string>()
  const settings = new Map<'model' | 'effort', ConfigRow>()
  let openPicker: Picker | undefined
  let debounce: { cancel: () => void } | undefined

  const view = (id: string, now: number): AgentView => {
    let one = agents.get(id)
    if (!one) {
      one = { id, label: id.slice(0, 8), type: '', status: 'running', startedAt: now, tools: 0, lastTool: '', todos: [] }
      agents.set(id, one)
    }

    return one
  }

  // Interactive sessions only: a `-p` or SDK run draws no pane, so it reads no git or gh.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    debounce?.cancel()
    commands = new Set((await $.command.list()).map(c => c.name))
    settings.clear()
    for (const row of await $.config.list()) {
      if (row.isLocked) continue
      if (/^model$/i.test(row.key) || /^model$/i.test(row.label)) settings.set('model', row)
      else if (/effort/i.test(row.key) || /effort/i.test(row.label)) settings.set('effort', row)
    }

    // The project root: unlike the session's directory, it does not follow the Bash tool's `cd`.
    const root = await $.session.root()
    const home = await $.env.get('HOME')
    isScanSkipped = root === '/' || root === home

    const refreshAgents = async () => {
      const now = await $.clock.now()
      const list = await $.agent.list()
      const seen = new Set<string>()
      for (const info of list) {
        seen.add(info.id)
        const one = view(info.id, now)
        one.label = info.description || info.name || info.id.slice(0, 8)
        one.type = info.type
        one.status = info.status
        if (TERMINAL.has(info.status) && one.endedAt === undefined) one.endedAt = now
      }
      for (const one of agents.values()) {
        if (!seen.has(one.id) && one.endedAt === undefined) {
          one.status = 'completed'
          one.endedAt = now
        }
      }
      while (agents.size > 20) agents.delete(agents.keys().next().value as string)
    }

    // The session folder and its direct children.
    const scan = async () => {
      if (isScanSkipped) {
        repos = []
        return
      }
      const found = await $.process.run(['find', root, '-maxdepth', '2', '-name', '.git'], { timeoutMs: 15000 })
      const dirs = found.stdout
        .split('\n')
        .filter(Boolean)
        .map(p => p.replace(/\/\.git$/, ''))
        .sort()
        .slice(0, MAX_REPOS)
      const old = new Map(repos.map(r => [r.dir, r]))
      repos = dirs.map(
        dir =>
          old.get(dir) ?? {
            dir,
            name: dir === root ? dir.split('/').pop() || dir : dir.slice(root.length + 1),
            branch: '…',
            dirty: 0,
            ahead: 0,
            behind: 0,
            hasGh: true,
          },
      )
    }

    const readGit = async (repo: Repo) => {
      const out = await $.process.run(['git', '-C', repo.dir, 'status', '--porcelain=v1', '-b'], { timeoutMs: 10000 })
      if (out.exitCode !== 0) return
      const lines = out.stdout.split('\n').filter(Boolean)
      const head = (lines[0] ?? '').replace(/^## /, '')
      repo.dirty = Math.max(0, lines.length - 1)
      repo.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
      repo.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
      repo.branch = head.replace(/^No commits yet on /, '').split('...')[0]?.split(' ')[0] || head
    }

    // One `gh pr view` per repo; its checks come in the same call, so a branch with no open PR costs nothing more.
    const readGh = async (repo: Repo) => {
      repo.ghAt = await $.clock.now()
      const ran = await $.process.run(
        ['gh', 'pr', 'view', '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup,url'],
        { cwd: repo.dir, timeoutMs: 20000 },
      ).catch(() => undefined)
      if (!ran || ran.exitCode !== 0) {
        repo.pr = undefined
        repo.ci = undefined
        repo.hasGh = !!ran && /no (open )?pull requests? found/i.test(ran.stderr)
        return
      }
      let j: Record<string, any>
      try {
        j = JSON.parse(ran.stdout) as Record<string, any>
      } catch {
        repo.pr = undefined
        repo.ci = undefined
        return
      }
      repo.hasGh = true
      repo.pr = { number: j.number, title: j.title, state: j.state, isDraft: !!j.isDraft, review: j.reviewDecision || undefined, url: j.url }
      repo.ci = j.state === 'OPEN' ? parseCi(j.statusCheckRollup) : undefined
      if (repo.ci && j.url) repo.ci.url = `${j.url}/checks`
    }

    const safe = (fn: () => Promise<void>) => () => {
      void fn().catch(err => $.ui.log(`session-panel: ${String(err)}`, { to: 'debug' })).finally(() => {
        $.ui.invalidate('ui.render')
      })
    }

    // Agents and usage every 2 s (local calls), only while Overview shows; hidden, agents alone while
    // one runs, so its end time stays right. The pane redraws when they change, while a subagent runs
    // (its clock ticks) or every 30 s for the "ago" labels.
    let lastSeen = ''
    let tick = 0
    const fast = async () => {
      try {
        const isShown = (await read($, tab)) === 'overview' && (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
        const isRunning = [...agents.values()].some(a => a.endedAt === undefined)
        if (!isShown && !isRunning) return
        await refreshAgents()
        if (!isShown) return
        live.model = await $.session.model()
        usage = await $.session.usage()
        // The spend counts from the session's start; a /clear moves it, and the sums start over with it.
        const startedAt = usage.startedAt
        await update($, spend, s => spendingSince(s, startedAt))
        const seen = JSON.stringify([live.model, usage, [...agents.values()]])
        const isTicking = [...agents.values()].some(a => a.endedAt === undefined)
        tick += 1
        if (seen !== lastSeen || isTicking || tick % 15 === 0) $.ui.invalidate('ui.render')
        lastSeen = seen
      } catch (err) {
        $.ui.log(`session-panel: ${String(err)}`, { to: 'debug' })
      }
    }

    // Session start and the ↻ button: rescan the folder, then every repo's git and gh.
    refreshAll = safe(async () => {
      if (isRefreshing) return
      isRefreshing = true
      $.ui.invalidate('ui.render')
      try {
        await scan()
        // One repo that fails does not stop the rest.
        const each = async (fn: (repo: Repo) => Promise<void>) => {
          for (const repo of repos) await fn(repo).catch(err => $.ui.log(`session-panel: ${repo.dir}: ${String(err)}`, { to: 'debug' }))
        }
        await each(readGit)
        await each(readGh)
        gitAt = await $.clock.now()
      } finally {
        isRefreshing = false
      }
    })
    refreshRepo = safe(async () => {
      const due = [...pending]
      pending.clear()
      const now = await $.clock.now()
      for (const [dir, wantsGh] of due) {
        const repo = repos.find(r => r.dir === dir)
        if (!repo) continue
        await readGit(repo)
        // A repo gh could not read waits for ↻.
        if (wantsGh && repo.hasGh && now - (repo.ghAt ?? 0) >= GH_GAP_MS) await readGh(repo)
      }
      gitAt = now
    })

    refreshAll()
    void fast()
    timers.push($.clock.every(FAST_MS, () => void fast()))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const one = view(e.agentId, await $.clock.now())
      const raw = e as unknown as Record<string, unknown>
      one.tools += 1
      if (e.tool === 'TodoWrite') {
        one.todos = (raw.todos as Todo[]) ?? []
      } else {
        one.lastTool = toolSummary(raw)
      }
    }
    const command = e.tool === 'Bash' ? String((e as unknown as Record<string, unknown>).command ?? '') : ''
    // Read before the call: a `cd` in the command moves the session's directory.
    const cwd = command && GIT_CMD.test(command) ? await $.session.cwd() : ''
    const ran = await next(e)
    // A `git` or `gh` call refreshes its own repo 3 s after the last one; gh only after a command that can
    // change what GitHub shows, at most once a minute per repo. Repos outside the session folder are skipped.
    if (cwd) {
      const repo = repoOf(repos, commandDir(command, cwd))
      if (repo) {
        pending.set(repo.dir, (pending.get(repo.dir) ?? false) || REMOTE_CMD.test(command))
        debounce?.cancel()
        debounce = $.clock.after(3000, () => refreshRepo?.())
      }
    }

    return ran
  })

  // The engine reports the session's prompt-cache TTL only with a model switch: each switch records it
  // first, whatever it decides. A model switch started from the pane is the person's own pick: it skips
  // the cache-loss prompt, once, and only for the model picked there.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const ttl = e.cache_ttl
    if (ttl === '5m' || ttl === '1h') await update($, cacheTtl, () => ttl)
    const result = await next(e)
    const to = live.switchTo
    if (!to || ![e.requested_model, e.to_model].some(m => m?.toLowerCase().includes(to))) return result
    live.switchTo = ''

    return { ...result, permissionDecision: 'allow' as const }
  })

  // After a switch, a fallback or a resume included.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const ttl = e.cache_ttl
    if (ttl === '5m' || ttl === '1h') await update($, cacheTtl, () => ttl)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if ((await read($, tab)) !== 'overview') return next(e)
    const width = Math.max(30, (e.viewport?.columns ?? 56) - 6)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const subModel = await read($, agentModel)
    const subEffort = await read($, agentEffort)
    const spending = await read($, spend)

    const frame = (title: string, color: string, right: RenderChildren, rows: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={0}>
        <Box justifyContent="space-between">
          <Text bold color={color}>{title}</Text>
          {right}
        </Box>
        {rows}
      </Box>
    )

    // A closed dropdown: the current value as a button; a press lists the options under the row.
    const toggle = (picker: Picker) => {
      openPicker = openPicker === picker ? undefined : picker
      $.ui.invalidate('ui.render')
    }
    const dropdown = (picker: Picker, current: string, isEnabled: boolean, color?: string) =>
      isEnabled ? (
        <Button plain key={`open-${picker}`} onPress={() => toggle(picker)}>
          <Text bold color={color}>{`${current} ${openPicker === picker ? '▴' : '▾'}`}</Text>
        </Button>
      ) : (
        <Text bold color={color}>{current}</Text>
      )
    const options = (picker: Picker, list: string[], isCurrent: (arg: string) => boolean, pick: (arg: string) => void) =>
      openPicker === picker ? (
        <Box flexDirection="column" marginLeft={2}>
          {list.map(arg => (
            <Button
              plain
              key={`${picker}-${arg}`}
              onPress={() => {
                openPicker = undefined
                pick(arg)
              }}
            >
              <Text color={isCurrent(arg) ? 'claude' : undefined} dimColor={!isCurrent(arg)}>{`${isCurrent(arg) ? '●' : '○'} ${arg}`}</Text>
            </Button>
          ))}
        </Box>
      ) : null

    // ── GIT ──
    const openUrl = async (url?: string) => {
      if (!url || !/^https:\/\//.test(url)) return
      const ran = await $.process.run(['open', url]).catch(() => undefined)
      if (!ran || ran.exitCode !== 0) await $.process.run(['xdg-open', url]).catch(() => undefined)
    }

    const gitRows = repos.length === 0
      ? [<Text dimColor>{isScanSkipped ? 'home folder or / : not scanned' : 'no git repository under the session folder'}</Text>]
      : repos.map(r => {
          const ciColor = r.ci?.state === 'pass' ? 'success' : r.ci?.state === 'fail' ? 'error' : 'warning'
          const ciIcon = r.ci?.state === 'pass' ? '✓' : r.ci?.state === 'fail' ? '✗' : '●'

          return (
            <Box flexDirection="column" marginBottom={0}>
              <Text bold>{fit(r.name, width)}</Text>
              <Text>
                <Text color="permission">{fit(r.branch, width - 18)}</Text>
                <Text dimColor>{r.ahead ? ` ↑${r.ahead}` : ''}{r.behind ? ` ↓${r.behind}` : ''}{r.dirty ? ` ±${r.dirty}` : ' clean'}</Text>
              </Text>
              <Box>
                {r.pr ? (
                  <Button plain key={`pr-${r.dir}`} label={`PR #${r.pr.number} ${r.pr.isDraft ? 'draft' : r.pr.state.toLowerCase()}${r.pr.review ? ` · ${r.pr.review.toLowerCase().replace('_', ' ')}` : ''}`} onPress={() => openUrl(r.pr?.url)} />
                ) : (
                  <Text dimColor>{r.hasGh ? 'no PR' : 'no gh / not on GitHub'}</Text>
                )}
                {r.ci ? (
                  <Button plain key={`ci-${r.dir}`} onPress={() => openUrl(r.ci?.url)}>
                    <Text color={ciColor}>{`  CI ${ciIcon} ${r.ci.done}/${r.ci.total}`}</Text>
                  </Button>
                ) : (
                  <Text dimColor>  CI –</Text>
                )}
              </Box>
            </Box>
          )
        })

    const gitRight = (
      <Box>
        <Text dimColor>{isRefreshing ? 'refreshing… ' : gitAt ? `${repos.length} repo${repos.length === 1 ? '' : 's'} · ${ago(now - gitAt)} ` : ''}</Text>
        <Button key="refresh" label="↻" hotkey="r" onPress={() => refreshAll?.()} />
      </Box>
    )

    // ── AGENTS ──
    const all = [...agents.values()].sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt) || b.startedAt - a.startedAt)
    const running = all.filter(a => !a.endedAt).length
    // The model and effort subagents spawned from now on get, unless the request names its own.
    const agentPickers = [
      <Box>
        <Text dimColor>model </Text>
        {dropdown('agentModel', subModel, true)}
        <Text dimColor>{'   effort '}</Text>
        {dropdown('agentEffort', subEffort, true)}
      </Box>,
      options('agentModel', [INHERIT, ...MODELS], arg => subModel === arg, arg => {
        void update($, agentModel, () => arg)
        void $.store.set('agentModel', arg)
      }),
      options('agentEffort', [INHERIT, ...EFFORTS], arg => subEffort === arg, arg => {
        void update($, agentEffort, () => arg)
        void $.store.set('agentEffort', arg)
      }),
    ]
    const agentRows = all.length === 0
      ? [<Text dimColor>no subagents yet</Text>]
      : all.slice(0, MAX_AGENTS).map(a => {
          const isDone = a.endedAt !== undefined
          const icon = a.status === 'failed' || a.status === 'killed' ? '✗' : isDone ? '✓' : '●'
          const color = a.status === 'failed' || a.status === 'killed' ? 'error' : isDone ? 'success' : 'warning'
          const total = a.todos.length
          const finished = a.todos.filter(t => t.status === 'completed').length

          return (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text><Text color={color}>{icon} </Text><Text bold>{fit(a.label, width - 14)}</Text></Text>
                <Text dimColor>{clock((a.endedAt ?? now) - a.startedAt)}</Text>
              </Box>
              {total > 0 ? (
                <Text>
                  <Text color={isDone ? 'success' : 'permission'}>{bar((finished / total) * 100, 12)}</Text>
                  <Text dimColor> {finished}/{total} tasks</Text>
                </Text>
              ) : null}
              {a.todos.slice(0, 6).map(t => (
                <Text dimColor={t.status !== 'in_progress'} color={t.status === 'in_progress' ? 'warning' : undefined}>
                  {t.status === 'completed' ? '  ✓ ' : t.status === 'in_progress' ? '  ▶ ' : '  ○ '}{fit(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content, width - 4)}
                </Text>
              ))}
              {!isDone && a.lastTool ? <Text dimColor>{'  '}{fit(`${a.tools} tools · ${a.lastTool}`, width - 2)}</Text> : null}
              {isDone && total === 0 ? <Text dimColor>{'  '}{a.tools} tools · {a.type}</Text> : null}
            </Box>
          )
        })

    // ── MODEL / USAGE ──
    const ctx = usage?.context
    const pct = ctx?.percent
    const five = usage?.rateLimits.find(r => r.kind === 'five_hour')
    const seven = usage?.rateLimits.find(r => r.kind === 'seven_day')
    const meter = (name: string, percent: number | undefined, extra: string) =>
      percent === undefined ? (
        <Text dimColor>{name.padEnd(4)}–</Text>
      ) : (
        <Text>
          <Text>{name.padEnd(4)}</Text>
          <Text color={level(percent)}>{bar(percent, 12)}</Text>
          <Text>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>
          <Text dimColor>{`  ${extra}`}</Text>
        </Text>
      )
    const window = ctx && ctx.window >= 1e6 ? `${ctx.window / 1e6}M` : `${Math.round((ctx?.window ?? 0) / 1000)}k`
    // The /config row applies at once, mid-turn included; the slash command waits for idle.
    const apply = async (command: 'model' | 'effort', arg: string) => {
      const row = settings.get(command)
      if (command === 'model') live.switchTo = arg
      try {
        if (row) {
          const value = row.options?.find(o => o.toLowerCase() === arg) ?? row.options?.find(o => o.toLowerCase().includes(arg)) ?? arg
          const { deny } = await $.config.set({ key: row.key, value })
          $.ui.toast(deny ? `${command} ${arg}: ${deny}` : `${command} → ${arg}`)
          if (!deny && command === 'effort') live.effort = arg
        } else {
          const done = await $.command.run({ command, args: arg })
          $.ui.toast(done.text ? String(done.text).split('\n')[0] ?? `/${command} ${arg}` : `/${command} ${arg}`)
          if (command === 'effort') live.effort = arg
        }
      } catch (err) {
        $.ui.toast(`${command} ${arg} failed: ${String(err)}`)
      } finally {
        live.switchTo = ''
      }
      live.model = await $.session.model()
      $.ui.invalidate('ui.render')
    }
    // Two lines in fixed columns, so the costs and tokens sit under each other: the session as /cost totals it
    // with its own loops' tokens, and the panel's forks (Decisions makes no request of its own).
    const pane = paneSpend(spending)
    const total = usage?.cost?.usd
    const session = spending.session
    const spendRow = (label: string, usd: string, input: number, output: number) => (
      <Text dimColor>{fit(`${label.padEnd(8)}${usd.padEnd(9)}i/o ${tokens(input)}/${tokens(output)}`, width)}</Text>
    )
    const spendRows = [
      total !== undefined || session.calls > 0 ? spendRow('session', total === undefined ? '–' : `$${total.toFixed(2)}`, session.input, session.output) : null,
      pane.calls > 0 ? spendRow('pane', pane.unpriced === 0 ? `~$${pane.usd.toFixed(2)}` : '–', pane.input, pane.output) : null,
    ]
    const canSwitch = (command: 'model' | 'effort') => settings.has(command) || commands.has(command)
    const modelRows = [
      <Box>
        {dropdown('model', live.model || '…', canSwitch('model'), 'claude')}
        <Text dimColor>{'   effort '}</Text>
        {dropdown('effort', live.effort || '–', canSwitch('effort'))}
      </Box>,
      options('model', MODELS, arg => live.model.toLowerCase().includes(arg), arg => void apply('model', arg)),
      options('effort', EFFORTS, arg => live.effort === arg, arg => void apply('effort', arg)),
      meter('ctx', pct, `${Math.round((ctx?.tokens ?? 0) / 1000)}k/${window}`),
      meter('5h', five?.percentUsed, five ? `reset ${until(five.resetsAt, now)}` : ''),
      meter('7d', seven?.percentUsed, seven ? `reset ${until(seven.resetsAt, now)}` : ''),
      ...spendRows,
    ]

    return (
      <Box flexDirection="column">
        {frame('MODEL', 'claude', <Text dimColor>{''}</Text>, modelRows)}
        {frame('GIT', 'permission', gitRight, gitRows)}
        {frame('SUBAGENTS', 'warning', <Text dimColor>{`${running} running · ${agents.size} total`}</Text>, [...agentPickers, ...agentRows])}
      </Box>
    )
  })
}
