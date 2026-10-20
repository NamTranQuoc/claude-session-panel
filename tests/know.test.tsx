import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkOutcome, isCheckStep, knowPrompt, noteDraft, parseNote, skipsAfter } from '../hooks/know-prompt'

const PANE = {
  plugin: 'session-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-panel',
  props: {} as never,
  viewport: { columns: 56, rows: 60, isDocked: true } as never,
} as const

const REPLY = [
  'learn: We turned on caching for one-off questions, so each one now costs more.',
  'tag: Heads up',
  'explain:',
  '**One-off questions cost more**',
  'Caching saves the start of a request for reuse.',
].join('\n')
const USAGE = { input_tokens: 3000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 0, output_tokens: 400 }

// The engine beneath the plugin: a placed pane, a fork that answers `reply` (and `explained` to an
// explanation request), turns that start and step.
const world = (on: On, { reply = REPLY, explained = '**Plainer**\nIn short.', store = {} } = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  const forks: string[] = []
  on('ui.panes', () => ({ value: [{ id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const text = e.prompt.includes('The person opened this note') ? explained : reply

    return { value: text ? { isAnswered: true, text, usage: USAGE } : { isAnswered: false, reason: 'empty-reply', usage: USAGE } } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })

  return { clock, forks }
}

const step = async ($: Parameters<TestBody>[0], index: number, turnId = 'turn-1') => {
  for await (const chunk of $.turn.step({ turnId, index, model: 'm', messageCount: 3 } as never)) void chunk
}

test('a reply parses to none, a note, or neither', () => {
  expect(parseNote('learn: none')).toEqual({ kind: 'none' })
  expect(parseNote('learn: "None."')).toEqual({ kind: 'none' })
  expect(parseNote('I found nothing.')).toEqual({ kind: 'unparsable' })
  expect(parseNote(`learn: ${'x'.repeat(260)}`)).toEqual({ kind: 'unparsable' })

  const note = parseNote(REPLY)
  expect(note).toEqual({
    kind: 'note',
    line: 'We turned on caching for one-off questions, so each one now costs more.',
    tag: 'Heads up',
    explanation: '**One-off questions cost more**\nCaching saves the start of a request for reuse.',
  })
  // A tag at the end of the line, a line wrapped over two, no period, no explain part.
  expect(parseNote('learn: The export is off by default\nso users cannot see it tag: Heads up')).toEqual({
    kind: 'note',
    line: 'The export is off by default so users cannot see it.',
    tag: 'Heads up',
    explanation: '',
  })
  expect(parseNote('- **learn:** Reads pay extra CPU now.\n**tag:** You should know').kind).toBe('note')
  // A line that opens with the word "None" is a note; a `tag:` inside the explanation is its text.
  expect(parseNote('learn: None of the retries are logged, so failures vanish.').kind).toBe('note')
  expect(parseNote('learn: Retries are silent.\nexplain:\n**T**\ntag: Heads up is a label here')).toMatchObject({ tag: 'You should know' })
  // Escape sequences go, CSI and OSC alike; a long explanation is cut.
  expect(parseNote('learn: Look \u001b[31mhere\u001b]8;;http://x\u0007 now.')).toMatchObject({ line: 'Look here now.' })
  expect((parseNote(`learn: Long.\nexplain:\n${'y'.repeat(5000)}`) as { explanation: string }).explanation).toHaveLength(4000)
})

test('a check outcome names why a note is not shown', () => {
  const reply = { isAnswered: true, text: REPLY, usage: USAGE } as never
  const now = { isOff: false, isStale: false, isFull: false }
  expect(checkOutcome(undefined, [], now).outcome).toBe('error')
  expect(checkOutcome({ isAnswered: false, reason: 'nothing-to-fork' }, [], now).outcome).toBe('nothing-to-fork')
  expect(checkOutcome({ isAnswered: true, text: 'learn: none', usage: USAGE } as never, [], now).outcome).toBe('none')
  expect(checkOutcome(reply, ['WE TURNED ON CACHING FOR ONE-OFF QUESTIONS, SO EACH ONE NOW COSTS MORE'], now).outcome).toBe('duplicate')
  expect(checkOutcome(reply, [], { ...now, isOff: true }).outcome).toBe('off')
  expect(checkOutcome(reply, [], { ...now, isStale: true }).outcome).toBe('stale')
  expect(checkOutcome(reply, [], { ...now, isFull: true }).outcome).toBe('full')
  expect(checkOutcome(reply, [], now)).toMatchObject({ outcome: 'shown', note: { tag: 'Heads up' } })
})

test('checks run on every 6th step and back off after ignored notes', () => {
  expect([0, 3, 6, 7, 12].map(isCheckStep)).toEqual([false, false, true, false, true])
  expect([1, 2, 3, 4, 5, 6, 7, 9].map(skipsAfter)).toEqual([0, 0, 1, 2, 4, 8, 16, 16])
})

test('the check prompt lists what to skip', () => {
  const prompt = knowPrompt(['Offered one.'], ['Known one.'], ['D1: Storage'])
  expect(prompt).toContain('- Offered one.')
  expect(prompt).toContain('- Known one.')
  expect(prompt).toContain('- D1: Storage')
  expect(knowPrompt([], [], [])).toContain('(none)')
})

test('a submitted note is quoted and keeps the composer from acting on it', () => {
  const draft = noteDraft({ tag: 'Heads up', line: 'Ask @alice before ultrathink runs.', explanation: '**T**\nbody' }, 'why so?')
  expect(draft).toBe('Here is a note offered by a side agent:\n\n> Heads up · Ask ＠alice before ultra-think runs.\n>\n> **T**\n> body\n\nwhy so?')
})

test('a check on the 6th step offers a note in the Know tab', async ($, on) => {
  const { clock, forks } = world(on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  expect(await ui.find({ type: 'Text', text: /Checks are off/ })).toBeDefined()

  // Off: no fork at any step.
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  expect(forks).toHaveLength(0)

  await ui.press({ key: 'know-toggle' })
  await step($, 5)
  await clock.settle()
  expect(forks).toHaveLength(0)
  await step($, 6)
  await clock.settle()
  expect(forks).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'Know 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /K1 {2}Heads up · We turned on caching/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last check: shown · in 3\.0k · cached 120k/ })).toBeDefined()

  // One note per turn; the same line is never offered twice.
  await step($, 12)
  await clock.settle()
  expect(forks).toHaveLength(1)
  await $.turn.start({ text: 'next', turnId: 'turn-2' } as never)
  await step($, 6, 'turn-2')
  await clock.settle()
  expect(forks).toHaveLength(2)
  expect(forks[1]).toContain('- We turned on caching')
  expect(await ui.find({ type: 'Text', text: /last check: duplicate/ })).toBeDefined()

  // Knew it: the note leaves, and the next check is told the user knows it.
  await ui.press({ key: 'note-1' })
  await ui.press({ key: 'note-knew-1' })
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeUndefined()
  await $.turn.start({ text: 'again', turnId: 'turn-3' } as never)
  await step($, 6, 'turn-3')
  await clock.settle()
  expect(forks[2]?.split('The person said they knew:')[1]).toContain('- We turned on caching')
  await ui.unmount()
})

test('a seen note passed by two prompts is dropped as ignored', async ($, on) => {
  const { clock } = world(on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeDefined()

  await $.turn.start({ text: 'a', turnId: 'turn-2' } as never)
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeDefined()
  await $.turn.start({ text: 'b', turnId: 'turn-3' } as never)
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeUndefined()
  await ui.unmount()
})

test('no check while the pane is not placed, or at three open notes', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let forks = 0
  let isPlaced = false
  on('ui.panes', () => ({ value: [{ id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced }] }))
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: true, text: REPLY.replace('one-off', `one-off ${forks}`), usage: USAGE } } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  // Overview on show: the notes are not seen, so the prompts below do not pass them by.
  await ui.press({ key: 'tab-overview' })

  await $.turn.start({ text: 'go', turnId: 'turn-0' } as never)
  await step($, 6, 'turn-0')
  await clock.settle()
  expect(forks).toBe(0)

  isPlaced = true
  for (const turn of [1, 2, 3, 4]) {
    await $.turn.start({ text: 'go', turnId: `turn-${turn}` } as never)
    await step($, 6, `turn-${turn}`)
    await clock.settle()
  }
  expect(forks).toBe(3)
  expect(await ui.find({ type: 'Text', text: 'Know 3' })).toBeDefined()
  await ui.unmount()
})

test('Submit sends the note and the reply to the main agent', async ($, on) => {
  const { clock } = world(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '' } as never)

  await ui.press({ key: 'note-1' })
  await ui.input({ key: 'note-input-1-0', text: 'is it worth it?' })
  await ui.press({ key: 'note-submit-1' })
  expect(sent[0]).toContain('> Heads up · We turned on caching')
  expect(sent[0]).toContain('is it worth it?')
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeUndefined()
  await ui.unmount()
})

test('a saved reply stays in its field, and a typed one is sent without Enter', async ($, on) => {
  const { clock } = world(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '' } as never)

  await ui.press({ key: 'note-1' })
  await ui.input({ key: 'note-input-1-0', text: 'first' })
  expect((await ui.find({ type: 'Input', key: 'note-input-1-1' }))?.props).toMatchObject({ value: 'first' })
  await ui.input({ key: 'note-input-1-1', text: 'second thought', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /● K1/ })).toBeDefined()
  await ui.press({ key: 'note-submit-1' })
  expect(sent[0]).toContain('second thought')
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeUndefined()
  await ui.unmount()
})

test('skips left by ignored notes are used up before the next check', async ($, on) => {
  const { clock, forks } = world(on, { store: { knowSkips: 2 } })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  for (const turn of [1, 2, 3]) {
    await $.turn.start({ text: 'go', turnId: `turn-${turn}` } as never)
    await step($, 6, `turn-${turn}`)
    await clock.settle()
  }
  expect(forks).toHaveLength(1)
  await ui.unmount()
})

test('a note without an explanation gets one, and a plainer one on request', async ($, on) => {
  const { clock, forks } = world(on, { reply: 'learn: Retries are silent.\ntag: Heads up' })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))

    return { value: undefined } as never
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()

  await ui.press({ key: 'note-1' })
  expect(await ui.find({ type: 'Button', key: 'note-simpler-1' })).toBeUndefined()
  await ui.press({ key: 'note-explain-1' })
  expect(forks[1]).toContain('Explain it.')
  expect(await ui.find({ type: 'Markdown', text: /Plainer/ })).toBeDefined()

  await ui.press({ key: 'note-simpler-1' })
  expect(forks[2]).toContain('They could not understand this explanation')
  expect(forks[2]).toContain('**Plainer**')
  expect(toasts).toHaveLength(0)
  await ui.unmount()
})

test('a failed explanation keeps the note and says so', async ($, on) => {
  const { clock } = world(on, { reply: 'learn: Retries are silent.\ntag: Heads up', explained: '' })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))

    return { value: undefined } as never
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  await ui.press({ key: 'note-1' })
  await ui.press({ key: 'note-explain-1' })
  expect(toasts.join()).toContain("Couldn't write that explanation")
  expect(await ui.find({ type: 'Button', key: 'note-explain-1' })).toBeDefined()
  await ui.unmount()
})

test('a dropped note prompt keeps the note', async ($, on) => {
  const { clock } = world(on)
  on('prompt.submit', () => ({ drop: 'blocked' }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  await ui.press({ key: 'know-toggle' })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  await step($, 6)
  await clock.settle()
  await $.turn.complete({ turnId: 'turn-1', reason: 'answer', answer: '' } as never)

  await ui.press({ key: 'note-1' })
  await ui.press({ key: 'note-submit-1' })
  expect(await ui.find({ type: 'Text', text: /K1/ })).toBeDefined()
  await ui.unmount()
})

test('the on/off pick of the last session comes back', async ($, on) => {
  mock.clock(on)
  mock.store(on, { knowOn: true })
  mock.env(on, { HOME: '/home' })
  // The rest of an interactive start, answered empty: no commands, settings, agents or repos.
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('config.list', () => ({ value: [] }) as never)
  on('session.cwd', () => ({ value: '/' }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never).catch(() => undefined)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-know' })
  expect(await ui.find({ type: 'Text', text: '[checks on]' })).toBeDefined()
  await ui.unmount()
})
