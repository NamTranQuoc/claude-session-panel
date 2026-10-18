import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { NO_SPENDING, paneSpend, usdOf, withSpend } from '../hooks/shared'

const PANE = {
  plugin: 'session-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-panel',
  props: {} as never,
  viewport: { columns: 56, rows: 60, isDocked: true } as never,
} as const

const OPUS = 'claude-opus-5-5'
const USAGE = { input_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 500 }
const NOTE = 'learn: The export is off by default, so users cannot see it.\ntag: Heads up\nexplain:\n**Export is off**\nIt ships dark.'

test('a request is priced by its model, and the panel sums its features', () => {
  // 2k in at $4, 100k cached at $0.20, 500 out at $20 per MTok.
  const micro = (usd: number | undefined) => (usd === undefined ? undefined : Math.round(usd * 1e6))
  expect(micro(usdOf(USAGE, OPUS))).toBe(8000 + 20000 + 10000)
  expect(micro(usdOf(USAGE, 'claude-sonnet-5-5[1m]'))).toBe(4000 + 20000 + 5000)
  expect(usdOf(USAGE, 'some-other-model')).toBeUndefined()

  const spent = withSpend(withSpend(withSpend(NO_SPENDING, 'explain', USAGE, OPUS), 'knowCheck', USAGE, OPUS), 'knowExplain', USAGE, 'unknown')
  expect(spent.explain).toEqual({ calls: 1, input: 102000, output: 500, usd: usdOf(USAGE, OPUS), unpriced: 0 })
  expect(paneSpend(spent)).toMatchObject({ calls: 3, input: 306000, output: 1500, unpriced: 1 })
})

test('the MODEL frame splits the session from the panel', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { knowOn: true })
  mock.env(on, { HOME: '/home' })
  // An interactive start with nothing to read, then a session that cost $1.00 so far.
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('config.list', () => ({ value: [] }) as never)
  on('session.cwd', () => ({ value: '/' }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: OPUS }) as never)
  on('session.usage', () => ({ value: { startedAt: 5, context: { window: 1000000 }, rateLimits: [], cost: { usd: 1 } } }) as never)
  on('ui.panes', () => ({ value: [{ id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] }))
  on('model.fork', () => ({ value: { isAnswered: true, text: NOTE, usage: USAGE } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { ...USAGE, model: OPUS } } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never).catch(() => undefined)
  const ui = await $.ui.mount(PANE)

  const step = async (index: number) => {
    for await (const chunk of $.turn.step({ turnId: 'turn-1', index, model: OPUS, messageCount: 3 } as never)) void chunk
  }
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  for (const index of [0, 1, 2, 3, 4, 5, 6]) await step(index)
  await clock.advance(2000)

  // Seven session requests; one Know check at $0.038. Columns line up: $, what it covers, i/o.
  const session = (await ui.find({ type: 'Text', text: /^session / }))?.text ?? ''
  const pane = (await ui.find({ type: 'Text', text: /^pane / }))?.text ?? ''
  expect(session).toMatch(/^session +\$1\.00 +main ~\$0\.96 +i\/o 714k\/3\.5k$/)
  expect(pane).toMatch(/^pane +~\$0\.04 +explain 0 · know 1 +i\/o 102k\/500$/)
  for (const column of [/[$~]/, /main|explain/, /i\/o/]) expect(session.search(column)).toBe(pane.search(column))
  await ui.unmount()
})

test('a /clear starts the spend over', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home' })
  let startedAt = 5
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('config.list', () => ({ value: [] }) as never)
  on('session.cwd', () => ({ value: '/' }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: OPUS }) as never)
  on('session.usage', () => ({ value: { startedAt, context: { window: 1000000 }, rateLimits: [], cost: { usd: 0.5 } } }) as never)
  on('ui.panes', () => ({ value: [{ id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { ...USAGE, model: OPUS } } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never).catch(() => undefined)
  const ui = await $.ui.mount(PANE)
  const step: Parameters<TestBody>[0]['turn']['step'] = input => $.turn.step(input)

  for await (const chunk of step({ turnId: 'turn-1', index: 0, model: OPUS, messageCount: 1 } as never)) void chunk
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /i\/o 102k/ })).toBeDefined()

  startedAt = 9
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /i\/o 102k/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^session +\$0\.50 +i\/o 0\/0$/ })).toBeDefined()
  await ui.unmount()
})
