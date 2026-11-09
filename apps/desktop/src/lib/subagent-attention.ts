/** One priority ladder for every subagent attention surface. */
export type SubagentAttention = 'waiting' | 'stuck' | 'over_budget' | 'unread'
export interface SubagentAttentionInput {
  attention?: 'waiting' | 'stuck'
  exitReason?: string
  end_reason?: string | null
  unread?: boolean
}
export type SubagentAttentionCounts = Partial<Record<SubagentAttention, number>>
export const SUBAGENT_ATTENTION_PRIORITY: readonly SubagentAttention[] = ['waiting', 'stuck', 'over_budget', 'unread']

export function subagentAttention(input: SubagentAttentionInput): SubagentAttention | undefined {
  const overBudget =
    input.unread !== false &&
    (input.exitReason === 'max_iterations' || input.end_reason === 'subagent_max_iterations')

  const flags = {
    waiting: input.attention === 'waiting',
    stuck: input.attention === 'stuck',
    over_budget: overBudget,
    unread: input.unread === true
  }

  return SUBAGENT_ATTENTION_PRIORITY.find(state => flags[state])
}

export function countSubagentAttention(subagents: readonly SubagentAttentionInput[]): SubagentAttentionCounts {
  const counts: SubagentAttentionCounts = {}

  for (const subagent of subagents) {
    const state = subagentAttention(subagent)

    if (state) {
      counts[state] = (counts[state] ?? 0) + 1
    }
  }

  return counts
}

/** Sources overlap (roster, live events, persisted row); never sum duplicates. */
export function rollupSubagentAttention(...sources: (SubagentAttentionCounts | undefined)[]): SubagentAttentionCounts {
  return Object.fromEntries(
    SUBAGENT_ATTENTION_PRIORITY.map(state => [state, Math.max(0, ...sources.map(source => source?.[state] ?? 0))])
  )
}

export function resolveSubagentAttention(
  counts: SubagentAttentionCounts
): { state: SubagentAttention; count: number } | undefined {
  const state = SUBAGENT_ATTENTION_PRIORITY.find(key => (counts[key] ?? 0) > 0)

  return state ? { state, count: counts[state]! } : undefined
}
