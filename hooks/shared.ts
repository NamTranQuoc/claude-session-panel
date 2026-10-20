import type { ModelUsage } from 'claude-code'

import type { SessionPanelDecision, SessionPanelSpend, SessionPanelSpending } from '../types'

export const PLUGIN = 'session-panel'
export const PANE = 'session-panel'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const INHERIT = 'inherit'

// The prompt cache's lifetime, as the engine reports it at a model switch.
export type CacheTtl = '5m' | '1h'

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

// US dollars per million tokens, Claude API list prices (as of 2026-10). A model not listed is counted in
// tokens only.
const PRICES = [
  { model: 'fable-5-1', input: 10, cacheRead: 0.25, output: 50 },
  { model: 'opus-5-5', input: 4, cacheRead: 0.2, output: 20 },
  { model: 'sonnet-5-5', input: 2, cacheRead: 0.2, output: 10 },
]

// The prompt cache's lifetime, and a cache write's price as a multiple of input: 1.25x for a 5-minute cache,
// 2x for 1 hour. A TTL not reported yet counts as 1 hour.
export const cacheTtlMs = (cacheTtl?: CacheTtl | '') => (cacheTtl === '5m' ? 5 * 60 * 1000 : 60 * 60 * 1000)
export const cacheWriteRate = (cacheTtl?: CacheTtl | '') => (cacheTtl === '5m' ? 1.25 : 2)

export const usdOf = (usage: ModelUsage, model: string, cacheTtl?: CacheTtl | '') => {
  const price = PRICES.find(p => model.includes(p.model))
  if (!price) return undefined
  const { input, cacheRead, output } = price

  return (
    (usage.input_tokens * input + usage.cache_read_input_tokens * cacheRead + usage.cache_creation_input_tokens * input * cacheWriteRate(cacheTtl) + usage.output_tokens * output) /
    1e6
  )
}

const NO_SPEND: SessionPanelSpend = { calls: 0, input: 0, output: 0, usd: 0, unpriced: 0 }
export const NO_SPENDING: SessionPanelSpending = { since: 0, session: NO_SPEND, explain: NO_SPEND, knowCheck: NO_SPEND, knowExplain: NO_SPEND }
export type SpendKey = Exclude<keyof SessionPanelSpending, 'since'>

// The sums as they count from the session's `startedAt`: a /clear moves it, and they start over with it;
// `since` 0 (nothing counted yet) only takes the first value.
export const spendingSince = (spending: SessionPanelSpending, startedAt: number): SessionPanelSpending =>
  spending.since === startedAt ? spending : spending.since === 0 ? { ...spending, since: startedAt } : { ...NO_SPENDING, since: startedAt }

// One request's usage added to `key`, in the sums that count from `startedAt`, cache writes priced at
// `cacheTtl`; input counts every input token, cached or not.
export const withSpend = (
  spending: SessionPanelSpending,
  key: SpendKey,
  usage: ModelUsage,
  model: string,
  startedAt: number,
  cacheTtl?: CacheTtl | '',
): SessionPanelSpending => {
  const base = spendingSince(spending, startedAt)
  const was = base[key]
  const usd = usdOf(usage, model, cacheTtl)

  return {
    ...base,
    [key]: {
      calls: was.calls + 1,
      input: was.input + usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      output: was.output + usage.output_tokens,
      usd: was.usd + (usd ?? 0),
      unpriced: was.unpriced + (usd === undefined ? 1 : 0),
    },
  }
}

// The panel's three features summed.
export const paneSpend = (s: SessionPanelSpending): SessionPanelSpend =>
  [s.explain, s.knowCheck, s.knowExplain].reduce((a, b) => ({
    calls: a.calls + b.calls,
    input: a.input + b.input,
    output: a.output + b.output,
    usd: a.usd + b.usd,
    unpriced: a.unpriced + b.unpriced,
  }))

// Text a sent prompt may act on: `@` opening a file mention, `ultra…` keywords.
export const inert = (text: string) => text.replace(/(^|\s)@(?=\S)/g, '$1＠').replace(/(ultra)(code|plan|review|think)/gi, '$1-$2')

// Text as a Markdown quote; an empty line stays a bare `>`.
export const quote = (text: string) =>
  text
    .split('\n')
    .map(l => (l ? `> ${l}` : '>'))
    .join('\n')

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
