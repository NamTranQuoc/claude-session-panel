import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SessionPanelChat, SessionPanelDecision, SessionPanelTab } from '../types'
import { DESCRIPTION, INPUT_SCHEMA, registerDecisions, TOOL } from './decisions'
import { registerExplain } from './explain'
import { registerOverview } from './overview'
import { live, PANE } from './shared'
import { endSubagent, registerSubagents } from './subagents'
import { RULES, SECTION_ID, takesRules } from './system'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const chats = atom({ plugin: 'session-panel', key: 'chats' } as const, [] as SessionPanelChat[])
const decisions = atom({ plugin: 'session-panel', key: 'decisions' } as const, [] as SessionPanelDecision[])

const PANE_OPEN = { id: PANE, title: 'Session', columns: 56 }

export const register: Register = on => {
  // Outermost Pane hook: the tab bar over the body the active tab's hook draws below.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const active = await read($, tab)
    const chatCount = (await read($, chats)).length
    const openCount = (await read($, decisions)).filter(d => d.sentAt === undefined).length
    const body = await next(e)

    const item = (id: SessionPanelTab, label: string) => (
      <Box marginRight={2}>
        <Button plain key={`tab-${id}`} onPress={() => void update($, tab, () => id)}>
          <Text bold={active === id} color={active === id ? 'claude' : undefined} dimColor={active !== id}>
            {label}
          </Text>
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          {item('overview', 'Overview')}
          {item('explain', chatCount ? `Explain ${chatCount}` : 'Explain')}
          {item('decisions', openCount ? `Decisions ${openCount}` : 'Decisions')}
        </Box>
        {body}
      </Box>
    )
  })

  // Interactive sessions only: the panel, its command and the tool it serves.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Toggle the session panel (overview, explain chats, decisions)' })
    await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    void $.ui.open(PANE_OPEN)

    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Session panel closed.' }
    }
    await $.ui.open(PANE_OPEN)

    return { text: 'Session panel opened.' }
  })

  // The panel's rules ride the system prompt from the first request on.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!takesRules(e.traits)) return composed

    return { ...composed, sections: [...composed.sections, { id: SECTION_ID, text: RULES, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      live.isMainRunning = true
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) live.isMainRunning = false
    endSubagent(e.agentId)
    $.ui.invalidate('ui.render')

    return next(e)
  })

  registerOverview(on)
  registerExplain(on)
  registerDecisions(on)
  registerSubagents(on)
}
