import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { SessionPanelChat, SessionPanelDecision, SessionPanelTab } from '../types'
import { BRIEF_PATH, briefRules } from './brief'
import { fit, listDecisions, PANE } from './shared'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const chats = atom({ plugin: 'session-panel', key: 'chats' } as const, [] as SessionPanelChat[])
const chatId = atom({ plugin: 'session-panel', key: 'chatId' } as const, 0)
const nextChatId = atom({ plugin: 'session-panel', key: 'nextChatId' } as const, 1)
const decisions = atom({ plugin: 'session-panel', key: 'decisions' } as const, [] as SessionPanelDecision[])

const MAX_TURNS = 20

const RULES = `You are answering a side question about the conversation above, in a separate explain chat the user opened from a panel.
- Explain only: concepts, keywords, decisions and code in this session. Never claim to have run, read, changed or checked anything now; every tool call is refused here.
- If an answer needs reading files or running commands, say it cannot be checked from this chat and suggest asking in the main conversation.
- D<n> names an item of the user's open decisions, listed below.`

// The explain prompt: rules, open decisions, the chat's own history, then the new question.
export const explainPrompt = (brief: string, openDecisions: string, history: SessionPanelChat['history'], question: string) => {
  const turns = history
    .slice(-MAX_TURNS)
    .map((turn, i) => `Q${i + 1}: ${turn.question}\nA${i + 1}: ${turn.answer}`)
    .join('\n\n')

  return [
    `<explain-rules>\n${RULES}\n\nAnswer style:\n${brief}\n</explain-rules>`,
    `<open-decisions>\n${openDecisions}\n</open-decisions>`,
    turns ? `<side-chat-so-far>\n${turns}\n</side-chat-so-far>` : '',
    `<new-question>\n${question}\n</new-question>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// The Explain tab: side chats, each question one `$.model.fork` over the main thread's last request.
export const registerExplain = (on: On) => {
  let brief: string | undefined

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if ((await read($, tab)) !== 'explain') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = ui
    // Every surface but mobile draws an Input; there the pane is read-only.
    const Input = 'Input' in ui ? ui.Input : undefined
    const width = Math.max(30, (e.viewport?.columns ?? 56) - 6)
    const list = await read($, chats)
    const selected = await read($, chatId)
    const chat = list.find(one => one.id === selected) ?? list[list.length - 1]

    const patch = (id: number, change: (one: SessionPanelChat) => SessionPanelChat) =>
      update($, chats, all => all.map(one => (one.id === id ? change(one) : one)))

    const ask = async (id: number, question: string) => {
      const current = (await read($, chats)).find(one => one.id === id)
      if (!current || current.isAsking || !question.trim()) return
      await patch(id, one => ({ ...one, draft: '', isAsking: true, notice: undefined }))
      if (brief === undefined) {
        const home = await $.env.get('HOME')
        brief = briefRules(home ? await $.fs.read(`${home}/${BRIEF_PATH}`).catch(() => undefined) : undefined)
      }
      const prompt = explainPrompt(brief, listDecisions(await read($, decisions)), current.history, question)

      const reply = await $.model.fork({ prompt }).catch(err => ({ isAnswered: false as const, reason: 'thrown' as const, err }))
      const notice = reply.isAnswered
        ? undefined
        : reply.reason === 'nothing-to-fork'
          ? 'No context yet: the main session has not sent a request (or was cleared).'
          : reply.reason === 'api-error'
            ? `API error ${reply.status ?? ''}: ${typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error)}`
            : reply.reason === 'thrown'
              ? `Failed: ${String(reply.err)}`
              : `No answer (${reply.reason}).`
      // A chat closed while asking is gone from the list, so the patch drops the reply.
      await patch(id, one => ({
        ...one,
        isAsking: false,
        notice,
        draft: reply.isAnswered ? '' : question,
        history: reply.isAnswered ? [...one.history, { question, answer: reply.text }] : one.history,
      }))
    }

    const add = async () => {
      const id = await read($, nextChatId)
      await update($, nextChatId, n => n + 1)
      await update($, chats, all => [...all, { id, history: [], draft: '', isAsking: false }])
      await update($, chatId, () => id)
    }
    const close = async (id: number) => {
      const rest = await update($, chats, all => all.filter(one => one.id !== id))
      await update($, chatId, () => rest[rest.length - 1]?.id ?? 0)
    }

    const chatTabs = (
      <Box flexWrap="wrap">
        {list.map(one => (
          <Box marginRight={1}>
            <Button plain key={`chat-${one.id}`} onPress={() => void update($, chatId, () => one.id)}>
              <Text bold={one.id === chat?.id} color={one.id === chat?.id ? 'claude' : undefined} dimColor={one.id !== chat?.id}>
                {`#${one.id}${one.isAsking ? '…' : ''}`}
              </Text>
            </Button>
          </Box>
        ))}
        <Button key="chat-add" label="+" onPress={() => void add()} />
      </Box>
    )

    if (!chat) {
      return (
        <Box flexDirection="column">
          {chatTabs}
          <Text dimColor>Press + to open an explain chat about this session.</Text>
          <Text dimColor>Each question reads the main session's latest request; nothing here acts.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {chatTabs}
        <Box justifyContent="space-between">
          <Text dimColor>{`chat #${chat.id} · ${chat.history.length} answer${chat.history.length === 1 ? '' : 's'}`}</Text>
          <Button plain key={`chat-close-${chat.id}`} onPress={() => void close(chat.id)}>
            <Text color="error">x</Text>
          </Button>
        </Box>
        {chat.history.map(turn => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="permission">{fit(`› ${turn.question}`, width * 3)}</Text>
            <Markdown text={turn.answer} />
          </Box>
        ))}
        {chat.notice ? <Text color="warning">{chat.notice}</Text> : null}
        <Box marginTop={1}>
          {chat.isAsking || !Input ? (
            <Text dimColor>{chat.isAsking ? 'asking…' : 'this surface has no text input'}</Text>
          ) : (
            <Input
              key={`chat-input-${chat.id}`}
              placeholder="Ask about this session (D<n> names a decision)"
              value={chat.draft}
              rows={3}
              submitLabel="Ask"
              onSubmit={(value: string) => void ask(chat.id, value)}
            />
          )}
        </Box>
      </Box>
    )
  })
}
