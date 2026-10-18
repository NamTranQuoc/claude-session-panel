import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { SessionPanelChat, SessionPanelDecision, SessionPanelSpending, SessionPanelTab } from '../types'
import { fit, listDecisions, live, NO_SPENDING, PANE, tokens, withSpend } from './shared'

const tab = atom({ plugin: 'session-panel', key: 'tab' } as const, 'overview' as SessionPanelTab)
const chats = atom({ plugin: 'session-panel', key: 'chats' } as const, [] as SessionPanelChat[])
const chatId = atom({ plugin: 'session-panel', key: 'chatId' } as const, 0)
const nextChatId = atom({ plugin: 'session-panel', key: 'nextChatId' } as const, 1)
const decisions = atom({ plugin: 'session-panel', key: 'decisions' } as const, [] as SessionPanelDecision[])
const spend = atom({ plugin: 'session-panel', key: 'spend' } as const, NO_SPENDING as SessionPanelSpending)

const MAX_TURNS = 20
// History sent with a question, newest first, up to this many characters.
const MAX_HISTORY_CHARS = 6000
// A reply that wrote this many prompt tokens to the cache re-sent the main context at full price.
const COLD_CACHE_TOKENS = 20000
// The API's default prompt-cache lifetime; idle longer, the main context is likely billed afresh.
const CACHE_TTL_MS = 5 * 60 * 1000

// The /brief rules that shape an answer, condensed.
const BRIEF = `- Same language as the question; technical terms and names stay in English.
- Cut words, never information: keep every case, condition, number, path and caveat that applies.
- No openers, recaps, offers or closers; first line is content.
- One fact: 1-3 plain sentences. Several points: a bold one-line conclusion per point, one supporting fact per sub-bullet, at most two levels.
- Explain what code does, when, and with what effect; point at \`file:line\` or a symbol instead of quoting code.
- Say each fact once; "not found" is a valid answer.`

const RULES = `You are answering a side question about the conversation above, in a separate explain chat the user opened from a panel.
- Explain only: concepts, keywords, decisions and code in this session. Never claim to have run, read, changed or checked anything now; every tool call is refused here.
- If an answer needs reading files or running commands, say it cannot be checked from this chat and suggest asking in the main conversation.
- D<n> names an item of the user's open decisions, listed below.`

// The explain prompt: rules, open decisions, the chat's recent history, then the new question.
export const explainPrompt = (openDecisions: string, history: SessionPanelChat['history'], question: string) => {
  const turns: string[] = []
  let size = 0
  for (const turn of history.slice(-MAX_TURNS).reverse()) {
    const text = `Q: ${turn.question}\nA: ${turn.answer}`
    if (size + text.length > MAX_HISTORY_CHARS && turns.length > 0) break
    turns.unshift(text)
    size += text.length
  }

  return [
    `<explain-rules>\n${RULES}\n\nAnswer style:\n${BRIEF}\n</explain-rules>`,
    `<open-decisions>\n${openDecisions}\n</open-decisions>`,
    turns.length ? `<side-chat-so-far>\n${turns.join('\n\n')}\n</side-chat-so-far>` : '',
    `<new-question>\n${question}\n</new-question>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// The Explain tab: side chats, each question one `$.model.fork` over the main thread's last request.
export const registerExplain = (on: On) => {
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
      // Warn before a fork the cold cache would bill at full price; asking again sends it.
      const now = await $.clock.now()
      const idle = now - live.mainAt
      if (live.mainAt > 0 && !live.isMainRunning && idle >= CACHE_TTL_MS && !current.isColdWarned) {
        const { context } = await $.session.usage()
        await patch(id, one => ({
          ...one,
          draft: question,
          isColdWarned: true,
          notice: `Main session idle ${Math.round(idle / 60000)}m: its prompt cache has likely expired, so this question re-sends about ${tokens(context.tokens ?? 0)} tokens of context at full price. Ask again to send it.`,
        }))
        return
      }
      await patch(id, one => ({ ...one, draft: '', isAsking: true, notice: undefined, isColdWarned: false }))
      const prompt = explainPrompt(listDecisions(await read($, decisions)), current.history, question)

      const reply = await $.model.fork({ prompt }).catch(err => ({ isAnswered: false as const, reason: 'thrown' as const, err }))
      // The fork read the main prefix, which renews its cache entry.
      if (reply.isAnswered) live.mainAt = await $.clock.now()
      // A fork runs on the main session's model.
      if ('usage' in reply && reply.usage) {
        const used = reply.usage
        await update($, spend, s => withSpend(s, 'explain', used, live.model))
      }
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
        history: reply.isAnswered
          ? [
              ...one.history,
              {
                question,
                answer: reply.text,
                usage: {
                  input: reply.usage.input_tokens,
                  cacheRead: reply.usage.cache_read_input_tokens,
                  cacheWrite: reply.usage.cache_creation_input_tokens,
                  output: reply.usage.output_tokens,
                },
              },
            ]
          : one.history,
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
            {turn.usage ? (
              <Text dimColor>
                {`in ${tokens(turn.usage.input)} · cached ${tokens(turn.usage.cacheRead)} · written ${tokens(turn.usage.cacheWrite)} · out ${tokens(turn.usage.output)}`}
              </Text>
            ) : null}
            {turn.usage && turn.usage.cacheWrite >= COLD_CACHE_TOKENS ? (
              <Text color="warning">{`cache was cold: ${tokens(turn.usage.cacheWrite)} tokens of the main context re-sent at full price`}</Text>
            ) : null}
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
