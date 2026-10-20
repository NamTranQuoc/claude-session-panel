// The session panel's state, kept by the host across hot reloads (`$.state`).

export type SessionPanelTab = 'overview' | 'explain' | 'decisions' | 'know'

// What one answer cost, as the API counted it.
export type SessionPanelUsage = { input: number; cacheRead: number; cacheWrite: number; output: number }

// Tokens and calls summed over a run of requests; `usd` prices the ones whose model has a price, `unpriced`
// counts the rest.
export type SessionPanelSpend = { calls: number; input: number; output: number; usd: number; unpriced: number }

// What this session spent, by who asked: the session's own loops (main and subagents) and each panel feature.
// `since` is the session's `startedAt` the sums count from; a /clear starts them over.
export type SessionPanelSpending = {
  since: number
  session: SessionPanelSpend
  explain: SessionPanelSpend
  knowCheck: SessionPanelSpend
  knowExplain: SessionPanelSpend
}

export type SessionPanelTurn = { question: string; answer: string; usage?: SessionPanelUsage }

export type SessionPanelChat = {
  id: number
  history: SessionPanelTurn[]
  // What the input shows: a question put back after a failed ask.
  draft: string
  isAsking: boolean
  notice?: string
  // The cold-cache warning was shown; the next ask goes through.
  isColdWarned?: boolean
}

export type SessionPanelDecision = {
  // Shown as D<id>; never reused within a session.
  id: number
  title: string
  detail: string
  options?: string[]
  answer?: string
  // Times the answer was saved or the item replaced: part of the answer Input's key, so each save draws a
  // fresh field that shows the saved text (the host empties a field after Enter).
  saves?: number
}

export type SessionPanelNoteTag = 'You should know' | 'Heads up'

// A note the side check found worth knowing; it stays until the user answers it or ignores it.
export type SessionPanelNote = {
  // Shown as K<id>; never reused within a session.
  id: number
  line: string
  tag: SessionPanelNoteTag
  // Markdown: a bold title line, then the body; '' when the check wrote none.
  explanation: string
  shownAt: number
  // The Know tab was drawn with this note in it; only then do prompts count as passing it by.
  isSeen: boolean
  // Prompts submitted since it was seen.
  promptsPast: number
  // The user's reply, saved from the Input; Submit puts it in the prompt box under the note.
  draft: string
  // Times the reply was saved: part of the reply Input's key, as a decision's `saves`.
  saves?: number
  isExplaining?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      tab: SessionPanelTab
      chats: SessionPanelChat[]
      chatId: number
      nextChatId: number
      decisions: SessionPanelDecision[]
      decisionId: number
      nextDecisionId: number
      agentModel: string
      agentEffort: string
      notes: SessionPanelNote[]
      noteId: number
      nextNoteId: number
      isKnowOn: boolean
      spend: SessionPanelSpending
    }
  }
}
