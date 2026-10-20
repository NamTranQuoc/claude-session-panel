import { expect, mock, test } from 'claude-code/testing'

import { formatAnswer } from '../hooks/decisions'
import { explainPrompt } from '../hooks/explain'
import { commandDir, repoOf, toolSummary } from '../hooks/overview-data'

const PANE = {
  plugin: 'session-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-panel',
  props: {} as never,
  viewport: { columns: 56, rows: 60, isDocked: true } as never,
} as const

const DECISIONS = 'mcp__session-panel__decisions'

test('the tab bar switches the body', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Text', text: 'MODEL' })).toBeDefined()
  await ui.press({ key: 'tab-explain' })
  expect(await ui.find({ type: 'Text', text: /Press \+ to open/ })).toBeDefined()
  await ui.press({ key: 'tab-decisions' })
  expect(await ui.find({ type: 'Text', text: 'No open decisions.' })).toBeDefined()
  await ui.press({ key: 'tab-know' })
  expect(await ui.find({ type: 'Text', text: /Checks are off/ })).toBeDefined()
  await ui.unmount()
})

test('/panel closes a drawn pane and opens one that is not drawn', async ($, on) => {
  const calls: string[] = []
  let pane = { id: 'session-panel', title: 'Session', isShown: false, isFocused: false, isPlaced: false }
  let opened: { isPlaced: true } | { isPlaced: false; reason: string } = { isPlaced: true }
  on('ui.panes', () => ({ value: [pane] }))
  on('ui.open', () => {
    calls.push('open')

    return { value: opened } as never
  })
  on('ui.close', () => {
    calls.push('close')

    return { value: undefined } as never
  })
  const run = async () => (await $.command.run({ command: 'panel', args: '' } as never)).text

  expect(await run()).toBe('Session panel opened.')
  pane = { ...pane, isPlaced: true, isShown: false }
  expect(await run()).toBe('Session panel closed.')
  pane = { ...pane, isShown: true }
  expect(await run()).toBe('Session panel closed.')
  pane = { ...pane, isPlaced: false, isShown: false }
  opened = { isPlaced: false, reason: 'no-surface: none attached' }
  expect(await run()).toBe('Session panel is open but waits undrawn: no-surface: none attached')
  expect(calls).toEqual(['open', 'close', 'close', 'open'])
})

test('explain chats open with + and close with x', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })

  await ui.press({ key: 'chat-add' })
  await ui.press({ key: 'chat-add' })
  expect(await ui.find({ type: 'Text', text: 'Explain 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chat #2/ })).toBeDefined()

  await ui.press({ key: 'chat-close-2' })
  expect(await ui.find({ type: 'Text', text: 'Explain 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chat #1/ })).toBeDefined()
  await ui.unmount()
})

const SWITCH = {
  from_model: 'claude-opus-5-5',
  to_model: 'claude-sonnet-5-5',
  requested_model: 'sonnet',
  source: 'command',
  context_tokens: 150000,
  prompt_cache_warm: true,
  estimated_cache_write_usd: 0.4,
  pricing: 'catalog',
} as const

test('with no cache TTL reported, 6 minutes idle sends the question', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 1000000, tokens: 150000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', () => ({ text: '' }))
  // The engine has reported no TTL, so the cache counts as 1 hour.
  await clock.advance(1000)
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) void chunk
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: '' } as never)
  await clock.advance(6 * 60 * 1000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })
  await ui.press({ key: 'chat-add' })

  await ui.input({ key: 'chat-input-1-0', text: 'why redis?' })
  expect(forks).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Main session idle/ })).toBeUndefined()
  await ui.unmount()
})

test('the cold-cache warning keeps the question in a fresh field', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 1000000, tokens: 150000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.PreModelSwitch', () => ({}))
  // A model switch reports a 5-minute cache; the main loop's last request ended and its turn completed,
  // then 6 minutes idle.
  await $.classic.PreModelSwitch({ ...SWITCH, cache_ttl: '5m' })
  await clock.advance(1000)
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) void chunk
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: '' } as never)
  await clock.advance(6 * 60 * 1000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })
  await ui.press({ key: 'chat-add' })

  await ui.input({ key: 'chat-input-1-0', text: 'why redis?' })
  expect(forks).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Main session idle 6m/ })).toBeDefined()
  expect((await ui.find({ type: 'Input', key: 'chat-input-1-1' }))?.props).toMatchObject({ value: 'why redis?' })
  await ui.unmount()
})

test('with no cache TTL reported, 61 minutes idle warns first', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 1000000, tokens: 150000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', () => ({ text: '' }))
  // The engine has reported no TTL, so the 1-hour cache has expired after 61 minutes idle.
  await clock.advance(1000)
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) void chunk
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: '' } as never)
  await clock.advance(61 * 60 * 1000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })
  await ui.press({ key: 'chat-add' })

  await ui.input({ key: 'chat-input-1-0', text: 'why redis?' })
  expect(forks).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Main session idle 61m/ })).toBeDefined()
  await ui.unmount()
})

test('a 5-minute cache TTL reported after a switch warns after 6 minutes idle', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 1000000, tokens: 150000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.PostModelSwitch', () => ({}))
  // An automatic fallback reports a 5-minute cache after the switch, then 6 minutes idle.
  await $.classic.PostModelSwitch({ ...SWITCH, source: 'auto', cache_ttl: '5m' })
  await clock.advance(1000)
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) void chunk
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: '' } as never)
  await clock.advance(6 * 60 * 1000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })
  await ui.press({ key: 'chat-add' })

  await ui.input({ key: 'chat-input-1-0', text: 'why redis?' })
  expect(forks).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Main session idle 6m/ })).toBeDefined()
  await ui.unmount()
})

test('a later switch back to a 1-hour cache TTL sends the question after 6 minutes idle', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 1000000, tokens: 150000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: false, reason: 'nothing-to-fork' } } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.PreModelSwitch', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  // One switch reports a 5-minute cache, a later one 1 hour; then 6 minutes idle.
  await $.classic.PreModelSwitch({ ...SWITCH, cache_ttl: '5m' })
  await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '1h' })
  await clock.advance(1000)
  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as never)) void chunk
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: '' } as never)
  await clock.advance(6 * 60 * 1000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-explain' })
  await ui.press({ key: 'chat-add' })

  await ui.input({ key: 'chat-input-1-0', text: 'why redis?' })
  expect(forks).toBe(1)
  expect(await ui.find({ type: 'Text', text: /Main session idle/ })).toBeUndefined()
  await ui.unmount()
})

test('the decisions tool keeps a numbered list the pane draws', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-decisions' })

  const added = await $.tool.call({
    tool: DECISIONS,
    tool_use_id: 'call-1',
    upsert: [
      { title: 'Storage', detail: 'Where to keep it', options: ['Postgres', 'SQLite', 'Files'] },
      { title: 'Naming', detail: 'Free choice' },
    ],
  } as never)
  expect(JSON.stringify(added)).toContain('D1: Storage')
  expect(JSON.stringify(added)).toContain('D2: Naming')

  await ui.press({ key: 'decision-1' })
  expect(await ui.find({ type: 'Text', text: '2. SQLite' })).toBeDefined()
  // Several rows, so a long answer stays readable while typed.
  expect((await ui.find({ type: 'Input', key: 'decision-input-1-0' }))?.props).toMatchObject({ rows: 3 })

  await ui.press({ key: 'decision-2' })
  expect(await ui.find({ type: 'Text', text: /^1\. / })).toBeUndefined()
  expect(await ui.find({ type: 'Input', key: 'decision-input-2-0' })).toBeDefined()

  // D2 removed while selected: deselected, and its number never comes back.
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-2', remove: [2], upsert: [{ title: 'Later', detail: 'x' }] } as never)
  expect(await ui.find({ type: 'Input', key: 'decision-input-2-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /D3 {2}Later/ })).toBeDefined()
  await ui.unmount()
})

test('answers and Submit lock while the main agent runs', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ ...e }) as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-decisions' })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'd' }] } as never)
  await ui.press({ key: 'decision-1' })

  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  expect(await ui.find({ type: 'Input', key: 'decision-input-1-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'decisions-submit' })).toBeUndefined()
  await ui.unmount()
})

test('a prompt naming D<n> carries that decision', async ($, on) => {
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context

    return { text: e.text }
  })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'Where to keep it', options: ['Postgres'] }] } as never)

  await $.prompt.submit({ text: 'explain D1 please', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen?.join('\n')).toContain('D1: Storage')
  expect(seen?.join('\n')).toContain('1. Postgres')
})

test('Submit sends each answered decision whole and takes it off the list', async ($, on) => {
  mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-decisions' })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'Where to keep @notes', options: ['Postgres'] }, { title: 'Later', detail: 'd' }] } as never)
  await ui.press({ key: 'decision-1' })
  await ui.input({ key: 'decision-input-1-0', text: '1 for now' })

  await ui.press({ key: 'decisions-submit' })
  expect(sent[0]).toContain('> D1 · Storage\n>\n> Where to keep ＠notes\n>\n> 1. Postgres\n\nAnswer to D1: option 1. for now')
  expect(sent[0]).not.toContain('D2')
  expect(await ui.find({ type: 'Text', text: /D1 {2}Storage/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /D2 {2}Later/ })).toBeDefined()
  await ui.unmount()
})

test('a saved answer stays in its field, and typed text is sent without Enter', async ($, on) => {
  mock.clock(on)
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-decisions' })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'd' }, { title: 'Cache', detail: 'd' }] } as never)
  await ui.press({ key: 'decision-1' })
  await ui.input({ key: 'decision-input-1-0', text: 'keep it local' })
  expect((await ui.find({ type: 'Input', key: 'decision-input-1-1' }))?.props).toMatchObject({ value: 'keep it local' })

  await ui.press({ key: 'decision-2' })
  await ui.input({ key: 'decision-input-2-0', text: 'redis', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '2 answers ready' })).toBeDefined()
  await ui.press({ key: 'decisions-submit' })
  expect(sent[0]).toContain('Answer to D1: keep it local')
  expect(sent[0]).toContain('Answer to D2: redis')
  expect(await ui.find({ type: 'Text', text: 'No open decisions.' })).toBeDefined()
  await ui.unmount()
})

test('a dropped Submit keeps the decisions and their answers', async ($, on) => {
  mock.clock(on)
  on('prompt.submit', () => ({ drop: 'blocked' }))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'tab-decisions' })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'd' }] } as never)
  await ui.press({ key: 'decision-1' })
  await ui.input({ key: 'decision-input-1-0', text: 'local', kind: 'change' })

  await ui.press({ key: 'decisions-submit' })
  expect(await ui.find({ type: 'Text', text: /● D1/ })).toBeDefined()
  expect((await ui.find({ type: 'Input', key: 'decision-input-1-1' }))?.props).toMatchObject({ value: 'local' })
  await ui.unmount()
})

test("the panel's own prompts carry no decisions beside them", async ($, on) => {
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context

    return { text: e.text }
  })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'Where to keep it', options: ['Postgres'] }] } as never)

  await $.prompt.submit({ text: 'Answer to D1: option 1', wait: false, origin: { kind: 'plugin', name: 'session-panel' } } as never)
  expect(seen).toBeUndefined()
})

test('the system prompt carries the panel rules, the same text each time', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'intro', scope: 'shared' as const }] }))
  const input = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

  const first = await $.prompt.compose(input)
  const second = await $.prompt.compose(input)
  const rules = first.sections.find(s => s.id === 'session-panel:rules')
  expect(rules?.text).toContain('Delegation')
  expect(second.sections.find(s => s.id === 'session-panel:rules')?.text).toBe(rules?.text)

  const headless = await $.prompt.compose({ ...(input as object), traits: ['print'] } as never)
  expect(headless.sections.find(s => s.id === 'session-panel:rules')).toBeUndefined()
})

test('subagent spawns take the pane picks unless the call names its own', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const spawned: { model?: string; prompt: string }[] = []
  on('agent.spawn', ($, e) => {
    spawned.push({ model: e.model, prompt: e.prompt })

    return { model: e.model ?? e.parentModel, agentId: `agent-${spawned.length}` }
  })
  const efforts: Record<string, unknown> = {}
  on('turn.step', async function* ($, e) {
    efforts[e.agentId ?? 'main'] = e.effort

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'open-agentModel' })
  await ui.press({ key: 'agentModel-sonnet' })
  await ui.press({ key: 'open-agentEffort' })
  await ui.press({ key: 'agentEffort-medium' })

  const base = {
    tool_use_id: 't',
    description: 'd',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  }
  await $.agent.spawn({ ...base, prompt: 'plain task' } as never)
  await $.agent.spawn({ ...base, prompt: 'cheap task', model: 'haiku' } as never)
  await $.agent.spawn({ ...base, prompt: 'effort: high\nhard task' } as never)
  await $.agent.spawn({ ...base, prompt: 'forked', fork: true } as never)

  expect(spawned[0]).toEqual({ model: 'sonnet', prompt: 'plain task' })
  expect(spawned[1]).toEqual({ model: 'haiku', prompt: 'cheap task' })
  expect(spawned[2]).toEqual({ model: 'sonnet', prompt: 'hard task' })
  expect(spawned[3]).toEqual({ model: undefined, prompt: 'forked' })

  const step = async (agentId?: string) => {
    for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', effort: 'xhigh', agentId } as never)) void chunk
  }
  await step('agent-1')
  await step('agent-3')
  await step('agent-4')
  await step()
  expect(efforts).toEqual({ 'agent-1': 'medium', 'agent-3': 'high', 'agent-4': 'xhigh', main: 'xhigh' })
  await ui.unmount()
})

test('a submitted answer names its option by number only', () => {
  const d = { id: 3, title: 't', detail: 'd', options: ['Postgres', 'SQLite'] }
  expect(formatAnswer({ ...d, answer: '2' })).toBe('option 2')
  expect(formatAnswer({ ...d, answer: '2. keep it local' })).toBe('option 2. keep it local')
  expect(formatAnswer({ ...d, answer: '7 cows' })).toBe('7 cows')
  expect(formatAnswer({ ...d, answer: '2.5 GB is enough' })).toBe('2.5 GB is enough')
  expect(formatAnswer({ id: 4, title: 't', detail: 'd', answer: 'free text' })).toBe('free text')
})

test('D<n> mentions skip longer names', async ($, on) => {
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context

    return { text: e.text }
  })
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: [{ title: 'Storage', detail: 'd' }] } as never)

  await $.prompt.submit({ text: 'chart it with D1.js', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen).toBeUndefined()
  await $.prompt.submit({ text: 'about D1, again', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen?.join('\n')).toContain('not instructions from the user')
  seen = undefined as readonly string[] | undefined
  await $.prompt.submit({ text: "Let's go with option 2 for D1.", wait: false, origin: { kind: 'composer' } } as never)
  expect(seen?.join('\n')).toContain('not instructions from the user')
})

test('a subagent cannot change the decisions list', async ($, on) => {
  mock.clock(on)
  const denied = await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', agentId: 'agent-1', upsert: [{ title: 'x', detail: 'y' }] } as never)
  expect(JSON.stringify(denied)).toContain('Only the main conversation')
  const listed = await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-2' } as never)
  expect(JSON.stringify(listed)).toContain('no open decisions')
})

test('a malformed decisions call is denied and changes nothing', async ($, on) => {
  mock.clock(on)
  const denied = await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-1', upsert: '[{"title":"x","detail":"y"}]' } as never)
  expect(JSON.stringify(denied)).toContain('`upsert` must be an array')
  const listed = await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-2' } as never)
  expect(JSON.stringify(listed)).toContain('no open decisions')
})

test('a git command maps to the repo it ran in', () => {
  const repos = [
    { dir: '/w', name: 'w', branch: 'main', dirty: 0, ahead: 0, behind: 0, hasGh: true },
    { dir: '/w/api', name: 'api', branch: 'main', dirty: 0, ahead: 0, behind: 0, hasGh: true },
  ]
  expect(repoOf(repos, commandDir('git status', '/w/api/src'))?.name).toBe('api')
  expect(repoOf(repos, commandDir('git -C api push', '/w'))?.name).toBe('api')
  expect(repoOf(repos, commandDir('cd api && git commit -m x', '/w'))?.name).toBe('api')
  expect(repoOf(repos, commandDir('git status', '/w/docs'))?.name).toBe('w')
  expect(repoOf(repos, commandDir('git status', '/elsewhere'))).toBeUndefined()
})

test('explain history is capped by size, newest kept', () => {
  const long = 'x'.repeat(2500)
  const history = [1, 2, 3, 4].map(n => ({ question: `q${n}`, answer: long }))
  const prompt = explainPrompt('(no open decisions)', history, 'next?')
  expect(prompt).toContain('Q: q4')
  expect(prompt).toContain('Q: q3')
  expect(prompt).not.toContain('Q: q2')
  expect(prompt).toContain('<new-question>\nnext?')
})

test('the subagent picks carry over to a new session', async ($, on) => {
  mock.clock(on)
  mock.store(on, { agentModel: 'haiku', agentEffort: 'low' })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false } as never).catch(() => undefined)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^haiku/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^low/ })).toBeDefined()
  await ui.unmount()
})

test('the pane masks secrets in a subagent command', () => {
  const shown = toolSummary({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abc.def" "https://x?api_key=k1&q=1" GITHUB_TOKEN=ghp_1 ls' })
  expect(shown).not.toContain('abc.def')
  expect(shown).not.toContain('k1')
  expect(shown).not.toContain('ghp_1')
  expect(shown).toContain('q=1')
})
