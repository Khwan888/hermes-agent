import { atom } from 'nanostores'

import type { SessionInfo } from '@/types/hermes'

import { $gatewayActivationEpoch } from './gateway-activation-epoch'
import type { SessionOwnerScope } from './session-request-router'

/** Exact-id child reads stay off the ordinary session list. Cache only page identity. */
export const $resolvedSubagentPages = atom<Record<string, SessionInfo>>({})
$gatewayActivationEpoch.subscribe(() => $resolvedSubagentPages.set({}))

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
