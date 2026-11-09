import type { LiveWorkRoster } from '@/store/live-work-roster'
import type { SubagentProgress } from '@/store/subagents'
import type { SessionInfo } from '@/types/hermes'

import { countSubagentAttention, rollupSubagentAttention, type SubagentAttentionCounts } from './subagent-attention'

export const subagentSessionAliases = (row: SessionInfo) =>
  new Set([row.id, row._lineage_root_id, ...(row._lineage_ids ?? [])].filter(Boolean))

/** Include grandchildren in a root fold, and only descendants in a child fold. */
function descendants(row: SessionInfo, bySession: Record<string, SubagentProgress[]>) {
  const aliases = subagentSessionAliases(row)
  const all = Object.values(bySession).flat()
  const own = all.filter(subagent => aliases.has(subagent.sessionId))
  const ids = new Set(own.map(subagent => subagent.id))
  const children = all.filter(subagent => aliases.has(subagent.parentSessionId))
  let frontier = own

  while (frontier.length) {
    frontier = all.filter(subagent => subagent.parentId && ids.has(subagent.parentId) && !ids.has(subagent.id))
    frontier.forEach(subagent => {
      ids.add(subagent.id)
      children.push(subagent)
    })
  }

  for (const [id, subagents] of Object.entries(bySession)) {
    if (aliases.has(id)) {
      children.push(...subagents)
    }
  }

  return [...new Map(children.filter(subagent => !own.includes(subagent)).map(subagent => [subagent.id, subagent])).values()]
}

export function sessionSubagentAttention(
  row: SessionInfo,
  bySession: Record<string, SubagentProgress[]>,
  roster: LiveWorkRoster
): SubagentAttentionCounts {
  const aliases = subagentSessionAliases(row)
  const subagents = descendants(row, bySession)
  const eventAt = Math.max(-Infinity, ...subagents.map(subagent => subagent.updatedAt))

  // Placeholder rows (no stored session yet) can't be opened, so only their live flags count.
  const live = countSubagentAttention(
    subagents.map(subagent => (subagent.sessionId ? subagent : { attention: subagent.attention }))
  )

  const sources = Object.values(roster).filter(bucket =>
    [...aliases].some(id => id && (bucket.covers.has(id) || bucket.sessions[id]))
  )

  const newest = sources.sort((a, b) => b.at - a.at)[0]

  const polled = newest
    ? rollupSubagentAttention(...[...aliases].map(id => (id ? newest.sessions[id]?.attention : undefined)))
    : undefined

  const active = newest && newest.at > eventAt ? polled : { waiting: live.waiting, stuck: live.stuck }

  return rollupSubagentAttention(row.subagent_attention, { unread: live.unread, over_budget: live.over_budget }, active)
}
