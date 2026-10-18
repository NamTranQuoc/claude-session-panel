import type { SessionPanelDecision } from '../types'

export const PLUGIN = 'session-panel'
export const PANE = 'session-panel'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const INHERIT = 'inherit'

// What the hooks learn as the session runs; a reload restarts it and the next event refills it.
export const live = {
  // The main loop's model and effort, as its last request named them.
  model: '',
  effort: '',
  isMainRunning: false,
  // When the main loop's last request ended, or a fork last read its cache; 0 until one has.
  mainAt: 0,
  // The model a pane pick is switching to, until the switch asks; '' otherwise.
  switchTo: '',
  // The main loop's latest turn, from its `turn.start`.
  turnId: '',
}

export const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

// `$.store` values as kept: a list of strings, a count; anything else reads as empty.
export const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
export const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0)

export const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text

export const listDecisions = (list: readonly SessionPanelDecision[]) =>
  list.length === 0 ? '(no open decisions)' : list.map(d => `D${d.id}: ${d.title}`).join('\n')

export const describeDecision = (d: SessionPanelDecision) =>
  [
    `D${d.id}: ${d.title}`,
    d.detail,
    ...(d.options ?? []).map((o, i) => `${i + 1}. ${o}`),
    d.answer ? `User's draft answer: ${d.answer}` : '',
  ]
    .filter(Boolean)
    .join('\n')
