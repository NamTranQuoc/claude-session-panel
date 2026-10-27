import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { SessionPanelNote, SessionPanelSpending, SessionPanelTab, SessionPanelUsage } from '../types'
import { cleanExplanation, explainNotePrompt, KEPT_LINES, noteDraft, noteKey } from './know-prompt'
import { fit, live, NO_SPENDING, PANE, strings, tokens, withSpend } from './shared'
import type { CacheTtl } from './shared'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const notes = atom({ plugin: 'session-panel', key: 'notes' } as const, [] as SessionPanelNote[])
const noteId = atom({ plugin: 'session-panel', key: 'noteId' } as const, 0)
const isKnowOn = atom({ plugin: 'session-panel', key: 'isKnowOn' } as const, false)
const spend = atom({ plugin: 'session-panel', key: 'spend' } as const, NO_SPENDING as SessionPanelSpending)
const cacheTtl = atom({ plugin: 'session-panel', key: 'cacheTtl' } as const, '' as CacheTtl | '')

// What the checks are doing, for the hook that runs them (`turn.step`) and the tab that shows the last one.
export const knowLive = {
  isChecking: false,
  // The turn whose check offered a note: one note per turn.
  offeredTurn: '',
  last: undefined as { outcome: string; usage?: SessionPanelUsage } | undefined,
}

// A reply typed into a note's field and not saved with Enter, by id, so Submit sends it too. Not in the
// atom: a change of the drawn `value` resets the field the person is typing in.
const typed = new Map<number, string>()
const replyOf = (n: SessionPanelNote) => typed.get(n.id) ?? n.draft

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
    // Answered notes leave the list.
    const close = async (answered: readonly SessionPanelNote[], isKnown: boolean) => {
      const ids = new Set(answered.map(n => n.id))
      for (const id of ids) typed.delete(id)
      await update($, notes, all => all.filter(n => !ids.has(n.id)))
      if (isKnown) {
        const known = strings(await $.store.get('knowKnown'))
        const added = answered.map(n => n.line).filter(line => !known.some(k => noteKey(k) === noteKey(line)))
        if (added.length) await $.store.set('knowKnown', [...known, ...added].slice(-KEPT_LINES))
      }
    }
    const explain = async (note: SessionPanelNote) => {
      if (note.isExplaining) return
      await patch(note.id, { isExplaining: true })
      const reply = await $.model.fork({ prompt: explainNotePrompt(note.line, note.explanation) }).catch(() => undefined)
      // The fork read the main prefix, which renews its cache entry.
      if (reply?.isAnswered) live.mainAt = await $.clock.now()
      if (reply && 'usage' in reply && reply.usage) {
        const used = reply.usage
        const { startedAt } = await $.session.usage()
        const ttl = await read($, cacheTtl)
        await update($, spend, s => withSpend(s, 'knowExplain', used, live.model, startedAt, ttl))
      }
      const text = reply?.isAnswered ? cleanExplanation(reply.text) : ''
      if (!text) $.ui.toast("Couldn't write that explanation.")
      await patch(note.id, { isExplaining: false, ...(text ? { explanation: text } : {}) })
    }
    const save = async (id: number, value: string) => {
      typed.delete(id)
      await update($, notes, all => all.map(n => (n.id === id ? { ...n, draft: value, saves: (n.saves ?? 0) + 1 } : n)))
    }
    // Redrawn only when the note turns replied or not, for its mark and the count.
    const edit = (note: SessionPanelNote, value: string) => {
      const wasReplied = Boolean(replyOf(note).trim())
      typed.set(note.id, value)
      if (wasReplied !== Boolean(value.trim())) $.ui.invalidate('ui.render')
    }
    // As Decisions' Submit: typed replies that were not saved are saved first; Submit never needs an
    // Enter. Sent, the replied notes leave the list as known: the prompt quotes them. A dropped prompt
    // keeps them (the host shows why).
    const submit = async () => {
      if (live.isMainRunning) return
      const pending = new Map(typed)
      typed.clear()
      let saved: SessionPanelNote[] = []
      await update($, notes, all => {
        saved = all.map(n => (pending.has(n.id) ? { ...n, draft: pending.get(n.id) ?? '', saves: (n.saves ?? 0) + 1 } : n))

        return saved
      })
      const replied = saved.filter(n => n.draft.trim())
      if (replied.length === 0) return $.ui.toast("No replies to send: type one in a note's field.")
      const sent = await $.prompt.submit({ text: noteDraft(replied) }).catch(() => undefined)
      if (!sent) return $.ui.toast("Couldn't send the replies. Press Submit to try again.")
      if (sent.drop) return
      await close(replied, true)
      const ids = new Set(replied.map(n => n.id))
      await update($, noteId, id => (ids.has(id) ? 0 : id))
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

    const readyCount = list.filter(n => replyOf(n).trim()).length
    const isLocked = live.isMainRunning

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          {isOn ? (
            <Text dimColor>Nothing to know yet. While this pane is on show, a side check runs every 6 steps of a long turn, from the 7th.</Text>
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
                {fit(`${replyOf(n).trim() ? '●' : '✦'} K${n.id}  ${n.tag} · ${n.line}`, width)}
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
                <Button key={`note-understood-${selected.id}`} label="Understood" onPress={() => void close([selected], true)} />
                <Button key={`note-knew-${selected.id}`} label="Knew this already" onPress={() => void close([selected], true)} />
                <Button key={`note-irrelevant-${selected.id}`} label="Not relevant" onPress={() => void close([selected], false)} />
                {selected.explanation && !selected.isExplaining ? (
                  <Button key={`note-simpler-${selected.id}`} label="Couldn't understand" onPress={() => void explain(selected)} />
                ) : null}
                <Button key={`note-dismiss-${selected.id}`} label="Dismiss" onPress={() => void close([selected], false)} />
              </Box>
            </Box>
            {/* Outside the bordered box: the host sizes an Input to the pane's full width. */}
            {isLocked || !Input ? (
              <Text dimColor>
                {replyOf(selected) ? `reply: ${replyOf(selected)} · ` : ''}
                {isLocked ? 'main agent is running' : 'this surface has no text input'}
              </Text>
            ) : (
              // A new key per save, as in Decisions: the host empties a field once Enter is handled.
              <Input
                key={`note-input-${selected.id}-${selected.saves ?? 0}`}
                placeholder="Your reply to the main agent about this note"
                value={selected.draft}
                rows={3}
                submitLabel="Save"
                onInput={(value: string) => edit(selected, value)}
                onSubmit={(value: string) => void save(selected.id, value)}
              />
            )}
          </Box>
        ) : null}
        <Box marginTop={1} justifyContent="space-between">
          <Text dimColor>{`${readyCount} repl${readyCount === 1 ? 'y' : 'ies'} ready`}</Text>
          {isLocked ? (
            <Text dimColor>main agent is running</Text>
          ) : (
            <Button key="know-submit" label="Submit" variant="primary" onPress={() => void submit()} />
          )}
        </Box>
      </Box>
    )
  })
}
