// The session panel's state, kept by the host across hot reloads (`$.state`).

export type SessionPanelTab = 'overview' | 'explain' | 'decisions'

// What one answer cost, as the API counted it.
export type SessionPanelUsage = { input: number; cacheRead: number; cacheWrite: number; output: number }

export type SessionPanelTurn = { question: string; answer: string; usage?: SessionPanelUsage }

export type SessionPanelChat = {
  id: number
  history: SessionPanelTurn[]
  // What the input shows: a question put back after a failed ask.
  draft: string
  isAsking: boolean
  notice?: string
}

export type SessionPanelDecision = {
  // Shown as D<id>; never reused within a session.
  id: number
  title: string
  detail: string
  options?: string[]
  answer?: string
  sentAt?: number
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
    }
  }
}
