import { expect, mock, test } from 'claude-code/testing'

test('the pane draws the git, subagent and model frames', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({
    plugin: 'session-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-panel',
    props: {} as never,
    viewport: { columns: 56, rows: 40, isDocked: true } as never,
  })

  for (const title of ['GIT', 'SUBAGENTS', 'MODEL']) {
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  }
  await ui.unmount()
})
