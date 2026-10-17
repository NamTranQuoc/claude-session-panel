import { atom, read } from 'claude-code'
import type { ModelEffort, On } from 'claude-code'

import { EFFORTS, INHERIT, live } from './shared'

const agentModel = atom({ plugin: 'session-panel', key: 'agentModel' } as const, 'inherit')
const agentEffort = atom({ plugin: 'session-panel', key: 'agentEffort' } as const, 'inherit')

// A leading `effort: <level>` line: the main agent's way to pass the user's own effort request.
const EFFORT_LINE = /^\s*effort:\s*(low|medium|high|xhigh|max)\s*(\n|$)/i

// Effort per subagent, recorded at spawn and applied to each of its requests until its run ends.
const efforts = new Map<string, ModelEffort>()

export const endSubagent = (agentId: string | undefined) => {
  if (agentId !== undefined) efforts.delete(agentId)
}

// Applies the pane's subagent model and effort picks to spawns that do not name their own.
export const registerSubagents = (on: On) => {
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.isTeammate || e.workflow || e.resume) return next(e)

    const line = EFFORT_LINE.exec(e.prompt)
    const pickedModel = await read($, agentModel)
    const pickedEffort = await read($, agentEffort)
    const level = (line?.[1]?.toLowerCase() ?? (EFFORTS.includes(pickedEffort) ? pickedEffort : undefined)) as ModelEffort | undefined
    const prompt = line ? e.prompt.slice(line[0].length) : e.prompt
    const model = e.model === undefined && pickedModel !== INHERIT ? pickedModel : e.model

    const started = await next({ ...e, prompt, model })
    if (level && started.agentId) efforts.set(started.agentId, level)

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      live.model = e.model
      live.effort = e.effort === undefined ? '' : String(e.effort)

      return yield* next(e)
    }
    const level = efforts.get(e.agentId)

    return yield* next(level ? { ...e, effort: level } : e)
  })
}
