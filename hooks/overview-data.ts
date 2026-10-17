// The Overview tab's data shapes and formatting helpers; plain values, no `$`.

export type Ci = { state: 'pass' | 'fail' | 'pending'; done: number; total: number; url?: string }
export type Pr = { number: number; title: string; state: string; isDraft: boolean; review?: string; url?: string }
export type Repo = {
  dir: string
  name: string
  branch: string
  dirty: number
  ahead: number
  behind: number
  pr?: Pr
  ci?: Ci
  hasGh: boolean
  // When gh last read this repo.
  ghAt?: number
}
export type Todo = { content: string; status: string; activeForm?: string }
export type AgentView = {
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
export type Picker = 'model' | 'effort' | 'agentModel' | 'agentEffort'

export const TERMINAL = new Set(['completed', 'failed', 'killed'])

export const bar = (percent: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const level = (percent: number) =>
  percent >= 85 ? 'error' : percent >= 65 ? 'warning' : 'success'

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const until = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`

  return `${mins}m`
}

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

export const toolSummary = (e: Record<string, unknown>) => {
  const pick = e.file_path ?? e.command ?? e.pattern ?? e.query ?? e.url ?? e.description ?? ''

  return `${String(e.tool)} ${String(pick).replace(/\s+/g, ' ')}`.trim()
}

export const parseCi = (items: unknown): Ci | undefined => {
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

// The directory a git command runs in: its `-C <dir>`, or the leading `cd <dir> &&`, else the session's.
export const commandDir = (command: string, cwd: string) => {
  const target = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1] ?? /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command)?.[1]
  if (!target) return cwd
  const dir = target.replace(/^["']|["']$/g, '')

  return dir.startsWith('/') ? dir : `${cwd.replace(/\/$/, '')}/${dir}`
}

// The innermost scanned repo that holds `dir`; none when it lies outside every scanned repo.
export const repoOf = (repos: readonly Repo[], dir: string) =>
  repos
    .filter(r => dir === r.dir || dir.startsWith(`${r.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
