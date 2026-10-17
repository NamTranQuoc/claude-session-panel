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
  // True while a pane pick switches the model.
  isSwitching: false,
}

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
