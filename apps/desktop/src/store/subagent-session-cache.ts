import { atom } from 'nanostores'

import { sessionTreeKey } from '@/lib/session-branch-tree'
import type { SessionInfo } from '@/types/hermes'

import { $gatewayActivationEpoch } from './gateway-activation-epoch'
import type { SessionOwnerScope } from './session-request-router'

/** Subagent pages are not ordinary top-level sessions. Keep their read cache here. */
export const $subagentSessionRows = atom<Record<string, SessionInfo>>({})
export interface SubagentReadOverride {
  at: number
  unread?: boolean
  subagent_attention?: SessionInfo['subagent_attention']
}
export const $subagentReadOverrides = atom<Record<string, SubagentReadOverride>>({})
/** Child id -> count of confirmed read writes. A stored read taken before the write re-reads. */
export const $subagentReadEpoch = atom<Record<string, number>>({})

export function confirmSubagentRead(id: string) {
  const epochs = $subagentReadEpoch.get()
  $subagentReadEpoch.set({ ...epochs, [id]: (epochs[id] ?? 0) + 1 })
}

export function rememberSubagentSessions(rows: readonly SessionInfo[]) {
  const next = { ...$subagentSessionRows.get() }

  for (const row of rows) {
    next[sessionTreeKey(row)] = row
  }

  $subagentSessionRows.set(next)
}

/**
 * Identity-only record of delegate children resolved by exact id (open from a card, Agents or a
 * link). It answers "is this page a subagent's?" and nothing else: unread/attention read the
 * subagent cache above, which this must never feed with a stale snapshot.
 */
export const $resolvedSubagentPages = atom<Record<string, SessionInfo>>({})
$gatewayActivationEpoch.subscribe(() => {
  $resolvedSubagentPages.set({})
  $subagentSessionRows.set({})
  $subagentReadOverrides.set({})
  $subagentReadEpoch.set({})
})

export function isSubagentSession(row: SessionInfo): boolean {
  return row.is_internal_child ?? (!row._branched_from && !row._reset_from && row.source === 'subagent')
}

export function rememberSubagentPage(row: SessionInfo) {
  if (!isSubagentSession(row)) {
    return
  }

  const key = JSON.stringify([row.connection_id || 'local', row.profile || 'default', row.id])
  const next = { ...$resolvedSubagentPages.get(), [key]: row }
  const keys = Object.keys(next)

  for (const oldest of keys.slice(0, Math.max(0, keys.length - 200))) {
    delete next[oldest]
  }

  $resolvedSubagentPages.set(next)
}

export function isSubagentPageSession(
  storedId: null | string,
  listed: readonly SessionInfo[],
  cached: Record<string, SessionInfo>,
  owner: SessionOwnerScope
): boolean {
  if (!storedId || !owner) {
    return false
  }

  const profile = typeof owner === 'string' ? owner : owner.targetProfile || owner.profile
  const connectionId = typeof owner === 'string' ? 'local' : owner.connectionId

  const row = [...listed, ...Object.values(cached)].find(candidate =>
    (candidate.id === storedId || candidate._lineage_root_id === storedId || candidate._lineage_ids?.includes(storedId)) &&
    (candidate.profile || 'default') === profile && (candidate.connection_id || 'local') === connectionId
  )

  return Boolean(row && isSubagentSession(row))
}

export function subagentReadView(row: SessionInfo): SessionInfo {
  const key = sessionTreeKey(row)
  const source = row.is_internal_child ? ($subagentSessionRows.get()[key] ?? row) : row
  const override = $subagentReadOverrides.get()[key]

  return override && Date.now() - override.at < 10_000 ? { ...source, ...override } : source
}
