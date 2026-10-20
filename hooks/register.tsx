import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SessionPanelChat, SessionPanelDecision, SessionPanelNote, SessionPanelSpending, SessionPanelTab } from '../types'
import { DESCRIPTION, INPUT_SCHEMA, registerDecisions, TOOL } from './decisions'
import { registerExplain } from './explain'
import { knowLive, registerKnow } from './know'
import { checkOutcome, IGNORED_AFTER_PROMPTS, isCheckStep, KEPT_LINES, knowPrompt, MAX_OPEN_NOTES, skipsAfter } from './know-prompt'
import { registerOverview } from './overview'
import { count, live, NO_SPENDING, PANE, strings, withSpend } from './shared'
import type { CacheTtl } from './shared'
import { effortOf, endSubagent, registerSubagents } from './subagents'
import { RULES, SECTION_ID, takesRules } from './system'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const chats = atom({ plugin: 'session-panel', key: 'chats' } as const, [] as SessionPanelChat[])
const decisions = atom({ plugin: 'session-panel', key: 'decisions' } as const, [] as SessionPanelDecision[])
const notes = atom({ plugin: 'session-panel', key: 'notes' } as const, [] as SessionPanelNote[])
const nextNoteId = atom({ plugin: 'session-panel', key: 'nextNoteId' } as const, 1)
const isKnowOn = atom({ plugin: 'session-panel', key: 'isKnowOn' } as const, false)
const spend = atom({ plugin: 'session-panel', key: 'spend' } as const, NO_SPENDING as SessionPanelSpending)
const cacheTtl = atom({ plugin: 'session-panel', key: 'cacheTtl' } as const, '' as CacheTtl | '')

const PANE_OPEN = { id: PANE, title: 'Session', columns: 56 }

export const register: Register = on => {
  // Outermost Pane hook: the tab bar over the body the active tab's hook draws below.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const active = await read($, tab)
    const chatCount = (await read($, chats)).length
    const openCount = (await read($, decisions)).length
    const noteCount = (await read($, notes)).length
    const body = await next(e)
    // Opening Know shows its notes: from then on, prompts that pass them by count (`turn.start`).
    const show = async (id: SessionPanelTab) => {
      await update($, tab, () => id)
      if (id === 'know') await update($, notes, all => all.map(n => ({ ...n, isSeen: true })))
    }

    const item = (id: SessionPanelTab, label: string) => (
      <Box marginRight={2}>
        <Button plain key={`tab-${id}`} onPress={() => void show(id)}>
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
          {item('know', noteCount ? `Know ${noteCount}` : 'Know')}
        </Box>
        {body}
      </Box>
    )
  })

  // Interactive sessions only: the panel, its command and the tool it serves.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Toggle the session panel (overview, explain chats, decisions, notes to know)' })
    await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    void $.ui.open(PANE_OPEN)

    return next(e)
  })

  // Closes the pane while it is drawn, on show or behind another pane's tab (an open would only retitle
  // it). One not open, or waiting undrawn, is opened, which places it at any width (the person asked).
  on('command.run', { command: 'panel' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE && p.isPlaced)) {
      await $.ui.close({ id: PANE })

      return { text: 'Session panel closed.' }
    }
    const opened = await $.ui.open(PANE_OPEN)

    return { text: opened.isPlaced ? 'Session panel opened.' : `Session panel is open but waits undrawn: ${opened.reason}` }
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
      live.turnId = e.turnId
      // A prompt passes the seen notes by; one passed by twice is dropped as ignored, and ignored ones
      // in a row make the next checks skip (`skipsAfter`). A store failure leaves the notes as they were.
      try {
        let ignored = 0
        await update($, notes, all => {
          ignored = 0

          return all.flatMap(n => {
            if (!n.isSeen) return [n]
            if (n.promptsPast + 1 < IGNORED_AFTER_PROMPTS) return [{ ...n, promptsPast: n.promptsPast + 1 }]
            ignored += 1
            return []
          })
        })
        if (ignored) {
          const inRow = count(await $.store.get('knowIgnored')) + ignored
          await $.store.set('knowIgnored', inRow)
          await $.store.set('knowSkips', skipsAfter(inRow))
        }
      } catch {
        // The turn goes on; only the ignore count missed this prompt.
      }
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  // Every model request: its usage counts toward the session's spend; a subagent's runs at its recorded
  // effort; the main loop's records its model and effort, and on step index 6, 12, … of a turn (the 7th,
  // 13th, … request) starts a Know check beside the request.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const level = effortOf(e.agentId)
      const done = yield* next(level ? { ...e, effort: level } : e)
      const used = done.usage
      if (used) {
        const { startedAt } = await $.session.usage()
        const ttl = await read($, cacheTtl)
        await update($, spend, s => withSpend(s, 'session', used, used.model, startedAt, ttl))
      }

      return done
    }
    live.model = e.model
    live.effort = e.effort === undefined ? '' : String(e.effort)

    const check = async (turnId: string) => {
      if (!(await read($, isKnowOn)) || (await read($, notes)).length >= MAX_OPEN_NOTES) return
      const panes = await $.ui.panes()
      if (!panes.some(p => p.id === PANE && p.isPlaced && p.isShown)) return
      const skips = count(await $.store.get('knowSkips'))
      if (skips > 0) {
        await $.store.set('knowSkips', skips - 1)
        return
      }

      const seen = strings(await $.store.get('knowSeen'))
      const known = strings(await $.store.get('knowKnown'))
      const open = (await read($, decisions)).map(d => `D${d.id}: ${d.title}`)
      knowLive.last = { outcome: 'checking…' }
      $.ui.invalidate('ui.render')
      const reply = await $.model.fork({ prompt: knowPrompt(seen, known, open) }).catch(() => undefined)
      // The fork read the main prefix, which renews its cache entry.
      if (reply?.isAnswered) live.mainAt = await $.clock.now()
      // A fork runs on the main session's model.
      if (reply && 'usage' in reply && reply.usage) {
        const used = reply.usage
        const { startedAt } = await $.session.usage()
        const ttl = await read($, cacheTtl)
        await update($, spend, s => withSpend(s, 'knowCheck', used, live.model, startedAt, ttl))
      }
      const usage =
        reply && 'usage' in reply && reply.usage
          ? { input: reply.usage.input_tokens, cacheRead: reply.usage.cache_read_input_tokens, cacheWrite: reply.usage.cache_creation_input_tokens, output: reply.usage.output_tokens }
          : undefined
      const { outcome, note } = checkOutcome(reply, [...seen, ...known], {
        isOff: !(await read($, isKnowOn)),
        isStale: live.turnId !== turnId,
        isFull: (await read($, notes)).length >= MAX_OPEN_NOTES,
      })
      knowLive.last = { outcome, usage }
      if (note) {
        const id = await read($, nextNoteId)
        await update($, nextNoteId, n => n + 1)
        const shownAt = await $.clock.now()
        // Offered while Know is the tab on show, the note is seen at once.
        const isSeen = (await read($, tab)) === 'know'
        await update($, notes, all => [...all, { id, line: note.line, tag: note.tag, explanation: note.explanation, shownAt, isSeen, promptsPast: 0, draft: '' }])
        await $.store.set('knowSeen', [...seen, note.line].slice(-KEPT_LINES))
        knowLive.offeredTurn = turnId
      }
    }
    if (isCheckStep(e.index) && !knowLive.isChecking && knowLive.offeredTurn !== e.turnId) {
      knowLive.isChecking = true
      // Beside the request, never before it: the main loop does not wait for a check.
      void check(e.turnId)
        .catch(() => {
          knowLive.last = { outcome: 'error' }
        })
        .finally(() => {
          knowLive.isChecking = false
          $.ui.invalidate('ui.render')
        })
    }

    const done = yield* next(e)
    live.mainAt = await $.clock.now()
    const used = done.usage
    if (used) {
      const { startedAt } = await $.session.usage()
      const ttl = await read($, cacheTtl)
      await update($, spend, s => withSpend(s, 'session', used, used.model, startedAt, ttl))
    }

    return done
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
  registerKnow(on)
  registerSubagents(on)
}
