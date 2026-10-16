import type { ConfigRow, Register, RenderChildren, SessionUsage } from 'claude-code'

const PANE = 'session-panel'
const FAST_MS = 2000
const GIT_CMD = /(^|[\s;&|(])(git|gh)\s/
const MAX_REPOS = 12
const MAX_AGENTS = 8

type Ci = { state: 'pass' | 'fail' | 'pending'; done: number; total: number; url?: string }
type Pr = { number: number; title: string; state: string; isDraft: boolean; review?: string; url?: string }
type Repo = {
  dir: string
  name: string
  branch: string
  dirty: number
  ahead: number
  behind: number
  pr?: Pr
  ci?: Ci
  hasGh: boolean
}
type Todo = { content: string; status: string; activeForm?: string }
type AgentView = {
  id: string
  label: string
  type: string
  status: string
  startedAt: number
  endedAt?: number
  tools: number
  lastTool: string
  todos: Todo[]
}

const TERMINAL = new Set(['completed', 'failed', 'killed'])

const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const level = (percent: number) =>
  percent >= 85 ? 'error' : percent >= 65 ? 'warning' : 'success'

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const until = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`

  return `${mins}m`
}

const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS: [label: string, arg: string][] = [['low', 'low'], ['med', 'medium'], ['high', 'high'], ['xh', 'xhigh'], ['max', 'max']]

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text

const toolSummary = (e: Record<string, unknown>) => {
  const pick = e.file_path ?? e.command ?? e.pattern ?? e.query ?? e.url ?? e.description ?? ''

  return `${String(e.tool)} ${String(pick).replace(/\s+/g, ' ')}`.trim()
}

const parseCi = (items: unknown): Ci | undefined => {
  if (!Array.isArray(items) || items.length === 0) return undefined
  let fail = 0
  let pending = 0
  let done = 0
  for (const item of items as Record<string, string>[]) {
    const verdict = item.conclusion || item.state || ''
    const isRunning = item.status !== undefined && item.status !== 'COMPLETED'
    if (isRunning || verdict === 'PENDING' || verdict === 'EXPECTED') {
      pending += 1
    } else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict)) {
      fail += 1
      done += 1
    } else {
      done += 1
    }
  }

  return { state: fail ? 'fail' : pending ? 'pending' : 'pass', done, total: items.length }
}

export const register: Register = on => {
  let repos: Repo[] = []
  const agents = new Map<string, AgentView>()
  const timers: { cancel: () => void }[] = []
  let model = ''
  let effort = ''
  let usage: SessionUsage | undefined
  let isOpen = false
  let isRefreshing = false
  let gitAt = 0
  let refreshAll: (() => void) | undefined
  let commands = new Set<string>()
  const settings = new Map<'model' | 'effort', ConfigRow>()
  let isSwitching = false
  let debounce: { cancel: () => void } | undefined

  const view = (id: string, now: number): AgentView => {
    let one = agents.get(id)
    if (!one) {
      one = { id, label: id.slice(0, 8), type: '', status: 'running', startedAt: now, tools: 0, lastTool: '', todos: [] }
      agents.set(id, one)
    }

    return one
  }

  on('session.start', async ($, e, next) => {
    for (const t of timers.splice(0)) t.cancel()
    debounce?.cancel()
    commands = new Set((await $.command.list()).map(c => c.name))
    settings.clear()
    for (const row of await $.config.list()) {
      if (row.isLocked) continue
      if (/^model$/i.test(row.key) || /^model$/i.test(row.label)) settings.set('model', row)
      else if (/effort/i.test(row.key) || /effort/i.test(row.label)) settings.set('effort', row)
    }
    await $.command.register({ name: 'panel', description: 'Toggle the session panel (git, subagents, usage)' })
    const open = async () => {
      isOpen = true
      await $.ui.open({ id: PANE, title: 'Session', columns: 56 })
    }
    void open()

    let busyGit = false
    let busyGh = false
    // Pinned at start: the session's directory follows every `cd` the Bash tool runs.
    const root = await $.session.cwd()

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

    const refreshUsage = async () => {
      model = await $.session.model()
      usage = await $.session.usage()
    }

    const scan = async () => {
      const found = await $.process.run(
        ['find', root, '-maxdepth', '3', '-name', '.git', '-not', '-path', '*/node_modules/*'],
        { timeoutMs: 15000 },
      )
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

    const refreshGit = async () => {
      if (busyGit) return
      busyGit = true
      try {
        for (const repo of repos) {
          const out = await $.process.run(['git', '-C', repo.dir, 'status', '--porcelain=v1', '-b'], { timeoutMs: 10000 })
          if (out.exitCode !== 0) continue
          const lines = out.stdout.split('\n').filter(Boolean)
          const head = (lines[0] ?? '').replace(/^## /, '')
          repo.dirty = Math.max(0, lines.length - 1)
          repo.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
          repo.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
          repo.branch = head.replace(/^No commits yet on /, '').split('...')[0]?.split(' ')[0] || head
        }
      } finally {
        busyGit = false
      }
    }

    const refreshGh = async () => {
      if (busyGh) return
      busyGh = true
      try {
        for (const repo of repos) {
          const prRun = await $.process.run(
            ['gh', 'pr', 'view', '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup,url'],
            { cwd: repo.dir, timeoutMs: 20000 },
          ).catch(() => undefined)
          if (prRun && prRun.exitCode === 0) {
            const j = JSON.parse(prRun.stdout) as Record<string, any>
            repo.pr = { number: j.number, title: j.title, state: j.state, isDraft: !!j.isDraft, review: j.reviewDecision || undefined, url: j.url }
            repo.ci = parseCi(j.statusCheckRollup)
            if (repo.ci && j.url) repo.ci.url = `${j.url}/checks`
            repo.hasGh = true
            continue
          }
          repo.pr = undefined
          const runs = await $.process.run(
            ['gh', 'run', 'list', '--branch', repo.branch, '--limit', '1', '--json', 'status,conclusion,url'],
            { cwd: repo.dir, timeoutMs: 20000 },
          ).catch(() => undefined)
          if (runs && runs.exitCode === 0) {
            const r = (JSON.parse(runs.stdout) as Record<string, string>[])[0]
            repo.ci = r
              ? { state: r.status !== 'completed' ? 'pending' : r.conclusion === 'success' ? 'pass' : 'fail', done: 1, total: 1, url: r.url }
              : undefined
          } else {
            repo.ci = undefined
            repo.hasGh = false
          }
        }
      } finally {
        busyGh = false
      }
    }

    const safe = (fn: () => Promise<void>) => () => {
      void fn().catch(err => $.ui.log(`session-panel: ${String(err)}`, { to: 'debug' })).finally(() => {
        if (isOpen) $.ui.invalidate('ui.render')
      })
    }

    const fast = safe(async () => {
      await refreshAgents()
      await refreshUsage()
    })
    refreshAll = safe(async () => {
      if (isRefreshing) return
      isRefreshing = true
      if (isOpen) $.ui.invalidate('ui.render')
      try {
        await scan()
        await refreshGit()
        await refreshGh()
        gitAt = await $.clock.now()
      } finally {
        isRefreshing = false
      }
    })

    refreshAll()
    fast()
    timers.push($.clock.every(FAST_MS, fast))

    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) {
      isOpen = false
      await $.ui.close({ id: PANE })

      return { text: 'Session panel closed.' }
    }
    isOpen = true
    await $.ui.open({ id: PANE, title: 'Session', columns: 56 })

    return { text: 'Session panel opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isOpen = false

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      model = e.model
      effort = e.effort === undefined ? '' : String(e.effort)
    }

    return yield* next(e)
  })

  // A switch started from the pane is the person's own pick: skip the cache-loss prompt.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const result = await next(e)

    return isSwitching ? { ...result, permissionDecision: 'allow' as const } : result
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.invalidate('ui.render')

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

    if (e.tool === 'Bash' && GIT_CMD.test(String((e as unknown as Record<string, unknown>).command ?? ''))) {
      const ran = await next(e)
      debounce?.cancel()
      debounce = $.clock.after(3000, () => refreshAll?.())

      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(30, (e.viewport?.columns ?? 56) - 6)
    const now = await $.clock.now()

    const frame = (title: string, color: string, right: RenderChildren, rows: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={0}>
        <Box justifyContent="space-between">
          <Text bold color={color}>{title}</Text>
          {right}
        </Box>
        {rows}
      </Box>
    )

    // ── GIT ──
    const openUrl = async (url?: string) => {
      if (!url || !/^https:\/\//.test(url)) return
      const ran = await $.process.run(['open', url]).catch(() => undefined)
      if (!ran || ran.exitCode !== 0) await $.process.run(['xdg-open', url]).catch(() => undefined)
    }

    const gitRows = repos.length === 0
      ? [<Text dimColor>no git repository under the session folder</Text>]
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
      isSwitching = true
      try {
        if (row) {
          const value = row.options?.find(o => o.toLowerCase() === arg) ?? row.options?.find(o => o.toLowerCase().includes(arg)) ?? arg
          const { deny } = await $.config.set({ key: row.key, value })
          $.ui.toast(deny ? `${command} ${arg}: ${deny}` : `${command} → ${arg}`)
          if (!deny && command === 'effort') effort = arg
        } else {
          const done = await $.command.run({ command, args: arg })
          $.ui.toast(done.text ? String(done.text).split('\n')[0] ?? `/${command} ${arg}` : `/${command} ${arg}`)
          if (command === 'effort') effort = arg
        }
      } catch (err) {
        $.ui.toast(`${command} ${arg} failed: ${String(err)}`)
      } finally {
        isSwitching = false
      }
      model = await $.session.model()
      $.ui.invalidate('ui.render')
    }
    const picker = (label: string, command: 'model' | 'effort', options: [string, string][], isCurrent: (arg: string) => boolean) =>
      settings.has(command) || commands.has(command) ? (
        <Box>
          <Text dimColor>{label.padEnd(7)}</Text>
          {options.map(([text, arg]) => (
            <Box marginRight={1}>
              <Button key={`${command}-${arg}`} label={text} variant={isCurrent(arg) ? 'primary' : undefined} dimColor={!isCurrent(arg)} onPress={() => apply(command, arg)} />
            </Box>
          ))}
        </Box>
      ) : null
    const modelRows = [
      <Text>
        <Text bold color="claude">{model || '…'}</Text>
        <Text dimColor>  effort </Text>
        <Text bold>{effort || '–'}</Text>
      </Text>,
      picker('model', 'model', MODELS.map(m => [m, m]), arg => model.toLowerCase().includes(arg)),
      picker('effort', 'effort', EFFORTS, arg => effort === arg),
      meter('ctx', pct, `${Math.round((ctx?.tokens ?? 0) / 1000)}k/${window}`),
      meter('5h', five?.percentUsed, five ? `reset ${until(five.resetsAt, now)}` : ''),
      meter('7d', seven?.percentUsed, seven ? `reset ${until(seven.resetsAt, now)}` : ''),
      usage?.cost ? <Text dimColor>session cost ${usage.cost.usd.toFixed(2)}</Text> : null,
    ]

    return (
      <Box flexDirection="column">
        {frame('MODEL', 'claude', <Text dimColor>{''}</Text>, modelRows)}
        {frame('GIT', 'permission', gitRight, gitRows)}
        {frame('SUBAGENTS', 'warning', <Text dimColor>{`${running} running · ${agents.size} total`}</Text>, agentRows)}
      </Box>
    )
  })
}
