import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { getSession } from '@/api/sessions'
import { subagentAttention } from '@/lib/subagent-attention'
import { knownOwnerForSession } from '@/store/session-states'
import {
  $subagentReadEpoch,
  $subagentReadOverrides,
  $subagentSessionRows,
  rememberSubagentSessions,
  subagentReadView
} from '@/store/subagent-session-cache'
import type { SessionInfo } from '@/types/hermes'

/** A parked dispatch outlives its live roster. Read its persisted attention,
 * while the existing owner-qualified read override still clears it on open. */
export function useStoredSubagentAttention(sessionId: string | undefined, parentId: string | null, parked: boolean) {
  useStore($subagentReadOverrides)
  useStore($subagentSessionRows)
  // A read confirmed after this card's first fetch must not leave its stale unread row behind.
  const readEpoch = useStore($subagentReadEpoch)[sessionId ?? ''] ?? 0
  const owner = knownOwnerForSession(parentId)
  const profile = typeof owner === 'string' ? owner : owner?.targetProfile || owner?.profile
  const connectionId = typeof owner === 'object' ? owner?.connectionId : undefined
  const hasOwner = Boolean(owner)
  const key = JSON.stringify([sessionId, profile, connectionId, parked, hasOwner, readEpoch])
  const [stored, setStored] = useState<{ key: string; row: SessionInfo } | null>(null)

  useEffect(() => {
    if (!parked || !sessionId || !hasOwner) {
      return
    }

    let active = true
    const scope = { profile, connectionId }
    void getSession(sessionId, scope)
      .then(row => {
        if (!active) {
          return
        }

        const owned = { ...row, profile: profile || 'default', connection_id: connectionId, is_internal_child: true }
        rememberSubagentSessions([owned])
        setStored({ key, row: owned })
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [key, sessionId, parentId, parked, profile, connectionId, hasOwner])

  if (stored?.key !== key || stored.row.ended_at == null) {
    return undefined
  }

  return subagentAttention(subagentReadView(stored.row))
}
