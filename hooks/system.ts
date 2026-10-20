import { PLUGIN } from './shared'

export const SECTION_ID = `${PLUGIN}:rules`

// Fixed text, present from the first request: it never moves the prompt cache mid-session.
export const RULES = `# Session panel: decisions and delegation

## Decisions
- When a question needs the user's choice, call the \`mcp__${PLUGIN}__decisions\` tool instead of asking in chat. The user answers in the session panel and submits the answers back as a prompt.
- D<n> (D1, D2, …) names one of those decisions, in your text and in the user's.
- The panel's Submit removes the decisions it answers. When the user settles one in chat instead, remove it with the tool.

## Delegation (main conversation)
- You implement the work yourself by default.
- Split the work into tasks and assign them to subagents (the Agent tool) only when the user decides to delegate it.
- As a subagent, do the task you were given.

## Subagent model and effort
- Set the Agent call's \`model\` only when the user asked for a specific model; otherwise leave it out and the session panel's pick applies.
- When the user asked for a specific effort, start the Agent \`prompt\` with the line \`effort: <low|medium|high|xhigh|max>\`.`

// A teammate's render keeps its lead's prompt; `--bare` keeps its one line; a `-p` or SDK session has
// no panel and no `decisions` tool.
const SKIPS = ['teammate', 'bare', 'print', 'sdk-preset']
export const takesRules = (traits: readonly string[]) => !traits.some(t => SKIPS.includes(t))
