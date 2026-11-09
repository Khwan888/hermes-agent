import { computed } from 'nanostores'

import { resolveSubagentAttention } from '@/lib/subagent-attention'
import { sessionSubagentAttention, subagentSessionAliases } from '@/lib/subagent-attention-rollup'
import type { SessionInfo } from '@/types/hermes'

import { $liveWorkRoster } from './live-work-roster'
import { $sessions } from './session'
import { $subagentsBySession } from './subagents'

export const $subagentNeedsYou = computed(
  [$subagentsBySession, $liveWorkRoster, $sessions],
  (bySession, roster, sessions) => {
    const ids = new Set([
      ...Object.keys(bySession),
      ...Object.values(roster).flatMap(bucket => Object.keys(bucket.sessions))
    ])

    const seen = new Set<string>()
    let waiting = 0
    let stuck = 0

    for (const id of ids) {
      const row = sessions.find(session => subagentSessionAliases(session).has(id)) ?? ({ id } as SessionInfo)
      const root = row._lineage_root_id || row.id

      if (seen.has(root)) {
        continue
      }

      seen.add(root)
      const counts = sessionSubagentAttention(row, bySession, roster)
      waiting += counts.waiting ?? 0
      stuck += counts.stuck ?? 0
    }

    return { count: waiting + stuck, state: resolveSubagentAttention({ waiting, stuck })?.state }
  }
)
