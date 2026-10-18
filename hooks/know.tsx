import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { SessionPanelNote, SessionPanelSpending, SessionPanelTab, SessionPanelUsage } from '../types'
import { explainNotePrompt, KEPT_LINES, noteDraft, noteKey } from './know-prompt'
import { fit, live, NO_SPENDING, PANE, strings, tokens, withSpend } from './shared'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const notes = atom({ plugin: 'session-panel', key: 'notes' } as const, [] as SessionPanelNote[])
const noteId = atom({ plugin: 'session-panel', key: 'noteId' } as const, 0)
const isKnowOn = atom({ plugin: 'session-panel', key: 'isKnowOn' } as const, false)
const spend = atom({ plugin: 'session-panel', key: 'spend' } as const, NO_SPENDING as SessionPanelSpending)

// What the checks are doing, for the hook that runs them (`turn.step`) and the tab that shows the last one.
export const knowLive = {
  isChecking: false,
  // The turn whose check offered a note: one note per turn.
  offeredTurn: '',
  last: undefined as { outcome: string; usage?: SessionPanelUsage } | undefined,
}

// The Know tab: notes a side check found worth knowing, each answered here or sent to the main agent.
export const registerKnow = (on: On) => {
  // The on/off pick of the last session, kept in the plugin's store; off until the user turns it on.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const saved = await $.store.get('knowOn')
    if (typeof saved === 'boolean') await update($, isKnowOn, () => saved)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if ((await read($, tab)) !== 'know') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = ui
    // Every surface but mobile draws an Input; there the pane is read-only.
    const Input = 'Input' in ui ? ui.Input : undefined
    const width = Math.max(30, (e.viewport?.columns ?? 56) - 6)
    const isOn = await read($, isKnowOn)
    const list = await read($, notes)
    const selectedId = await read($, noteId)
    const selected = list.find(n => n.id === selectedId)

    const patch = (id: number, change: Partial<SessionPanelNote>) =>
      update($, notes, all => all.map(n => (n.id === id ? { ...n, ...change } : n)))

    const toggle = async () => {
      const value = !(await read($, isKnowOn))
      await update($, isKnowOn, () => value)
      await $.store.set('knowOn', value)
    }
    // An answered note leaves the list; any answer ends a run of ignored notes and its skipped checks.
    const close = async (note: SessionPanelNote, isKnown: boolean) => {
      await update($, notes, all => all.filter(n => n.id !== note.id))
      if (isKnown) {
        const known = strings(await $.store.get('knowKnown'))
        if (!known.some(line => noteKey(line) === noteKey(note.line))) await $.store.set('knowKnown', [...known, note.line].slice(-KEPT_LINES))
      }
      await $.store.set('knowIgnored', 0)
      await $.store.set('knowSkips', 0)
    }
    const explain = async (note: SessionPanelNote) => {
      if (note.isExplaining) return
      await patch(note.id, { isExplaining: true })
      const reply = await $.model.fork({ prompt: explainNotePrompt(note.line, note.explanation) }).catch(() => undefined)
      if (reply && 'usage' in reply && reply.usage) {
        const used = reply.usage
        await update($, spend, s => withSpend(s, 'knowExplain', used, live.model))
      }
      const text = reply?.isAnswered ? reply.text.trim() : ''
      if (!text) $.ui.toast("Couldn't write that explanation.")
      await patch(note.id, { isExplaining: false, ...(text ? { explanation: text } : {}) })
    }
    // Submit sends the note and the reply to the main agent, as Decisions sends its answers. A dropped
    // prompt keeps the note: the host shows the drop's reason.
    const submit = async (note: SessionPanelNote) => {
      if (live.isMainRunning) return
      const sent = await $.prompt.submit({ text: noteDraft(note, note.draft) }).catch(() => undefined)
      if (!sent) return $.ui.toast("Couldn't send the note. Press Submit to try again.")
      if (!sent.drop) await close(note, true)
    }

    const last = knowLive.last
    // The last check's outcome and tokens, so its cost is measured rather than guessed.
    const header = (
      <Box flexDirection="column">
        <Button plain key="know-toggle" onPress={() => void toggle()}>
          <Text color={isOn ? 'success' : undefined} dimColor={!isOn}>{isOn ? '[checks on]' : '[checks off]'}</Text>
        </Button>
        {last ? (
          <Text dimColor wrap="wrap">
            {`last check: ${last.outcome}${last.usage ? ` · in ${tokens(last.usage.input)} · cached ${tokens(last.usage.cacheRead)} · written ${tokens(last.usage.cacheWrite)} · out ${tokens(last.usage.output)}` : ''}`}
          </Text>
        ) : null}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          {isOn ? (
            <Text dimColor>Nothing to know yet. While this pane is open, a side check runs on every 6th step of a long turn.</Text>
          ) : (
            <Text dimColor>Checks are off. Turned on, each check is one fork of the main session (its cached context plus the check's rules).</Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {list.map(n => {
          const isSelected = n.id === selected?.id

          return (
            <Button plain key={`note-${n.id}`} onPress={() => void update($, noteId, id => (id === n.id ? 0 : n.id))}>
              <Text bold={isSelected} color={isSelected ? 'claude' : undefined}>
                {fit(`${n.draft.trim() ? '●' : '✦'} K${n.id}  ${n.tag} · ${n.line}`, width)}
              </Text>
            </Button>
          )
        })}
        {selected ? (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
              <Text bold>{`K${selected.id}  ${selected.tag}`}</Text>
              <Text wrap="wrap">{selected.line}</Text>
              {selected.isExplaining ? (
                <Text dimColor>writing the explanation…</Text>
              ) : selected.explanation ? (
                <Markdown text={selected.explanation} />
              ) : (
                <Button key={`note-explain-${selected.id}`} label="Explain" onPress={() => void explain(selected)} />
              )}
              <Box flexWrap="wrap" marginTop={1}>
                <Button key={`note-understood-${selected.id}`} label="Understood" onPress={() => void close(selected, true)} />
                <Button key={`note-knew-${selected.id}`} label="Knew this already" onPress={() => void close(selected, true)} />
                <Button key={`note-irrelevant-${selected.id}`} label="Not relevant" onPress={() => void close(selected, false)} />
                {selected.explanation && !selected.isExplaining ? (
                  <Button key={`note-simpler-${selected.id}`} label="Couldn't understand" onPress={() => void explain(selected)} />
                ) : null}
                <Button key={`note-dismiss-${selected.id}`} label="Dismiss" onPress={() => void close(selected, false)} />
              </Box>
            </Box>
            {/* Outside the bordered box: the host sizes an Input to the pane's full width. */}
            {Input ? (
              <Input
                key={`note-input-${selected.id}`}
                placeholder="Your reply to the main agent about this note"
                value={selected.draft}
                rows={3}
                submitLabel="Save"
                onSubmit={(value: string) => void patch(selected.id, { draft: value })}
              />
            ) : (
              <Text dimColor>this surface has no text input</Text>
            )}
            {live.isMainRunning ? (
              <Text dimColor>main agent is running</Text>
            ) : (
              <Box justifyContent="flex-end">
                <Button key={`note-submit-${selected.id}`} label="Submit" variant="primary" onPress={() => void submit(selected)} />
              </Box>
            )}
          </Box>
        ) : null}
      </Box>
    )
  })
}
