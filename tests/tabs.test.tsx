import { expect, mock, test } from 'claude-code/testing'

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
  await ui.unmount()
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
  expect(await ui.find({ type: 'Input', key: 'decision-input-1' })).toBeDefined()

  await ui.press({ key: 'decision-2' })
  expect(await ui.find({ type: 'Text', text: /^1\. / })).toBeUndefined()
  expect(await ui.find({ type: 'Input', key: 'decision-input-2' })).toBeDefined()

  // D2 removed while selected: deselected, and its number never comes back.
  await $.tool.call({ tool: DECISIONS, tool_use_id: 'call-2', remove: [2], upsert: [{ title: 'Later', detail: 'x' }] } as never)
  expect(await ui.find({ type: 'Input', key: 'decision-input-2' })).toBeUndefined()
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
  expect(await ui.find({ type: 'Input', key: 'decision-input-1' })).toBeUndefined()
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

test('the system prompt carries the panel rules, the same text each time', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'intro', scope: 'shared' as const }] }))
  const input = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

  const first = await $.prompt.compose(input)
  const second = await $.prompt.compose(input)
  const rules = first.sections.find(s => s.id === 'session-panel:rules')
  expect(rules?.text).toContain('Plan mode')
  expect(second.sections.find(s => s.id === 'session-panel:rules')?.text).toBe(rules?.text)
})

test('subagent spawns take the pane picks unless the call names its own', async ($, on) => {
  mock.clock(on)
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
