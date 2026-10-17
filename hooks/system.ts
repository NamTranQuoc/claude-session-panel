import { PLUGIN } from './shared'

export const SECTION_ID = `${PLUGIN}:rules`

// Fixed text, present from the first request: it never moves the prompt cache mid-session.
export const RULES = `# Session panel: decisions and plan mode

## Decisions
- When a question needs the user's choice, call the \`mcp__${PLUGIN}__decisions\` tool instead of asking in chat. The user answers in the session panel and submits the answers back as a prompt.
- D<n> (D1, D2, …) names one of those decisions, in your text and in the user's.

## Plan mode (main conversation)
- In the main conversation you do not implement code or write contracts yourself. You gather context, synthesize, and write the plan with the user.
- Implementation and contract writing are assigned to subagents (the Agent tool).
- Exception: a small edit (at most about 10 changed lines in one file) you may make yourself, once the user has asked for it or confirmed it.
- Before implementation starts, ask the user to confirm the plan. Dispatch subagents only after the user says OK.
- Put open questions in \`decisions\` and keep asking until none is left before the plan is final.
- As a subagent, these plan-mode rules do not apply to you: do the task you were given.

## Subagent model and effort
- Set the Agent call's \`model\` only when the user asked for a specific model; otherwise leave it out and the session panel's pick applies.
- When the user asked for a specific effort, start the Agent \`prompt\` with the line \`effort: <low|medium|high|xhigh|max>\`.`

// A teammate's render keeps its lead's prompt; `--bare` keeps its one line.
export const takesRules = (traits: readonly string[]) => !traits.includes('teammate') && !traits.includes('bare')
