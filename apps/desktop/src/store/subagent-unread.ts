import { getSession, setSessionUnreadRemote } from '@/api/sessions'
import { isSubagentSession, sessionTreeKey } from '@/lib/session-branch-tree'
import { subagentAttention } from '@/lib/subagent-attention'
import type { SessionInfo } from '@/types/hermes'

import { $sessions, setSessions } from './session'
import type { SessionOwnerScope } from './session-request-router'
import { sessionsChangedHere } from './session-sync'
import {
  $subagentReadOverrides,
  $subagentSessionRows,
  confirmSubagentRead,
  rememberSubagentSessions
} from './subagent-session-cache'
import { $subagentsBySession } from './subagents'

const pending = new Map<string, Promise<boolean>>()

export function knownSubagent(id: string, owner?: SessionOwnerScope): SessionInfo | undefined {
  const profile = typeof owner === 'string' ? owner : owner?.profile
  const connectionId = typeof owner === 'object' ? owner?.connectionId : undefined

  return Object.values($subagentSessionRows.get()).find(
    row =>
      row.id === id &&
      row.is_internal_child &&
      (!profile || row.profile === profile) &&
      (!connectionId || row.connection_id === connectionId)
  )
}

function subagentContext(id: string, parentId?: string | null, route?: SessionOwnerScope): SessionInfo | undefined {
  const cached = knownSubagent(id, route)

  if (cached) {
    return cached
  }

  const live = Object.values($subagentsBySession.get())
    .flat()
    .find(row => row.sessionId === id)

  const ownerId = parentId || live?.parentSessionId

  if (!ownerId) {
    return undefined
  }

  const routeProfile = typeof route === 'string' ? route : route?.profile
  const routeConnection = typeof route === 'object' ? route?.connectionId : undefined

  const owner = [...$sessions.get(), ...Object.values($subagentSessionRows.get())].find(
    row =>
      row.id === ownerId &&
      (!routeProfile || (row.profile || 'default') === routeProfile) &&
      (!routeConnection || (row.connection_id || 'local') === routeConnection)
  )

  const profile = owner ? owner.profile || 'default' : typeof route === 'string' ? route : route?.profile
  const connectionId = owner?.connection_id || (typeof route === 'object' ? route?.connectionId : undefined)

  if (!profile) {
    return undefined
  }

  return {
    id,
    profile,
    connection_id: connectionId,
    is_internal_child: true,
    _delegate_from: ownerId,
    unread: live?.unread,
    end_reason:
      live?.exitReason === 'max_iterations'
        ? 'subagent_max_iterations'
        : live?.exitReason === 'timeout'
          ? 'subagent_timeout'
          : undefined
  } as SessionInfo
}

function subagentAncestors(child: SessionInfo): SessionInfo[] {
  const rows = [...$sessions.get(), ...Object.values($subagentSessionRows.get())]
  const ancestors: SessionInfo[] = []
  const seen = new Set([child.id])
  let id = child._delegate_from || child.parent_session_id

  while (id && !seen.has(id)) {
    seen.add(id)

    const parent = rows.find(
      row =>
        (row.id === id || row._lineage_ids?.includes(id!)) &&
        (row.profile || 'default') === (child.profile || 'default') &&
        (row.connection_id || 'local') === (child.connection_id || 'local')
    )

    if (!parent) {
      break
    }

    ancestors.push(parent)
    id = isSubagentSession(parent) ? parent._delegate_from || parent.parent_session_id : undefined
  }

  return ancestors
}

/**
 * Mark an opened subagent read, even when this child is absent from $sessions. Resolves true once
 * the backend holds the read (or it was just written), false when the write was refused or the
 * child is unknown, so the opened page can retry after its authorized mount.
 */
export function clearSubagentUnreadOnOpen(
  id: string,
  parentId?: string | null,
  owner?: SessionOwnerScope
): Promise<boolean> {
  const child = subagentContext(id, parentId, owner)

  if (!child) {
    return Promise.resolve(false)
  }

  const key = sessionTreeKey(child)
  const existing = pending.get(key)

  if (existing) {
    return existing
  }

  const operation = clearSubagent(child).finally(() => pending.delete(key))
  pending.set(key, operation)

  return operation
}

async function clearSubagent(child: SessionInfo): Promise<boolean> {
  const key = sessionTreeKey(child)
  const before = $subagentReadOverrides.get()

  const newlyUnread = Object.values($subagentsBySession.get())
    .flat()
    .some(row => row.sessionId === child.id && row.unread)

  if (!newlyUnread && before[key]?.unread === false && Date.now() - before[key].at < 10_000) {
    return true
  }

  const ancestors = subagentAncestors(child)
  const at = Date.now()
  const changes = { ...before, [key]: { at, unread: false } }
  const budget = subagentAttention(child) === 'over_budget'

  for (const parent of ancestors) {
    const parentKey = sessionTreeKey(parent)
    const counts = before[parentKey]?.subagent_attention ?? parent.subagent_attention
    changes[parentKey] = {
      at,
      subagent_attention: {
        unread: Math.max(0, (counts?.unread ?? 0) - (child.unread ? 1 : 0)),
        over_budget: Math.max(0, (counts?.over_budget ?? 0) - (budget ? 1 : 0))
      }
    }
  }

  $subagentReadOverrides.set(changes)
  const liveBefore = new Map<string, boolean | undefined>()

  for (const store of [$subagentsBySession]) {
    store.set(
      Object.fromEntries(
        Object.entries(store.get()).map(([sid, rows]) => [
          sid,
          rows.map(row => {
            if (row.sessionId !== child.id) {
              return row
            }

            liveBefore.set(row.id, row.unread)

            return { ...row, unread: false }
          })
        ])
      )
    )
  }

  try {
    await setSessionUnreadRemote(child.id, false, child.profile, child.connection_id)
  } catch {
    const current = { ...$subagentReadOverrides.get() }

    for (const changedKey of [key, ...ancestors.map(parent => sessionTreeKey(parent))]) {
      if (current[changedKey] !== changes[changedKey]) {
        continue
      }

      if (before[changedKey]) {
        current[changedKey] = before[changedKey]
      } else {
        delete current[changedKey]
      }
    }

    $subagentReadOverrides.set(current)

    for (const store of [$subagentsBySession]) {
      store.set(
        Object.fromEntries(
          Object.entries(store.get()).map(([sid, rows]) => [
            sid,
            rows.map(row => (liveBefore.has(row.id) ? { ...row, unread: liveBefore.get(row.id) } : row))
          ])
        )
      )
    }

    return false
  }

  const cached = $subagentSessionRows.get()[key]

  if (cached) {
    rememberSubagentSessions([{ ...cached, unread: false }])
  }

  // Surfaces that read this child before the write landed (a parked card) re-read it.
  confirmSubagentRead(child.id)

  // Reconcile the exact ancestor roll-ups, not a full sidebar reload. A failed
  // read leaves the bounded optimistic guard; the next list remains authoritative.
  await Promise.all(
    ancestors.map(async parent => {
      try {
        const fresh = await getSession(parent.id, { profile: parent.profile, connectionId: parent.connection_id })
        const parentKey = sessionTreeKey(parent)
        const current = $subagentReadOverrides.get()

        if (current[parentKey] === changes[parentKey]) {
          rememberSubagentSessions([{ ...fresh, profile: parent.profile, connection_id: parent.connection_id }])
          setSessions(rows =>
            rows.map(row =>
              sessionTreeKey(row) === parentKey ? { ...row, subagent_attention: fresh.subagent_attention } : row
            )
          )
          $subagentReadOverrides.set({ ...current, [parentKey]: { at, subagent_attention: fresh.subagent_attention } })
        }
      } catch {
        /* Next honest list read heals a failed refresh. */
      }
    })
  )
  // A sidebar page requested before the PATCH can land after this point and repaint the old roll-up;
  // a newer list request voids it, and other windows re-pull too.
  sessionsChangedHere()

  return true
}
