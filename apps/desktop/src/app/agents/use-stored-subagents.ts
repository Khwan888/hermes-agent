import type { SubagentRoute } from '@hermes/shared'
import { useEffect, useState } from 'react'

import { listSessionSubagents, markSubagentListingRouteMissing, subagentListingRouteMissing } from '@/api/sessions'
import { isUnroutedRestPath } from '@/lib/gateway-rpc'
import { knownOwnerForSession } from '@/store/session-states'
import { rememberSubagentPage } from '@/store/subagent-session-cache'
import type { SubagentProgress } from '@/store/subagents'
import type { SessionInfo } from '@/types/hermes'

const PAGE_SIZE = 50
const MAX_SUBAGENTS = 500
const MAX_REQUESTS = 100

interface StoredSubagent {
  parentId: string
  session: SessionInfo
}

/**
 * Where the durable history read stands. `unsupported` is a capability verdict (an older backend
 * without the child-listing route): live Agents keeps working and nothing retries. `failed` is
 * transient (offline, auth, timeout): rows read so far stay, and the panel offers Retry.
 */
export type StoredSubagentsStatus = 'failed' | 'idle' | 'loading' | 'ready' | 'unsupported'

export interface StoredSubagents {
  retry: () => void
  rows: StoredSubagent[]
  status: StoredSubagentsStatus
}

/** Read only descendants of the selected conversation, never a global history list. */
export function useStoredSubagents(sessionId: string | null, ownerRow: SessionInfo | undefined): StoredSubagents {
  const owner = knownOwnerForSession(sessionId)
  const profile = (typeof owner === 'string' ? owner : owner?.targetProfile || owner?.profile) || ownerRow?.profile || 'default'
  const connectionId = (typeof owner === 'object' ? owner?.connectionId : undefined) || ownerRow?.connection_id
  const hasOwner = Boolean(owner || ownerRow)
  const capabilityKey = connectionId || 'local'
  const [attempt, setAttempt] = useState(0)
  // Rows belong to one owner; a reload (Retry) of the same owner keeps them on screen until replaced.
  const key = JSON.stringify([sessionId, profile, connectionId, hasOwner])
  // A list refresh that changes the owner's child count re-reads history in place (no polling).
  const loadKey = JSON.stringify([key, attempt, ownerRow?.subagent_count ?? null])

  const [result, setResult] = useState<{ key: string; rows: StoredSubagent[]; status: StoredSubagentsStatus }>({
    key: '',
    rows: [],
    status: 'idle'
  })

  // The key gates old results synchronously, including before this effect's cleanup.
  useEffect(() => {
    if (!sessionId || !hasOwner) {return}

    if (subagentListingRouteMissing(capabilityKey)) {
      setResult({ key, rows: [], status: 'unsupported' })

      return
    }

    let cancelled = false
    const scope = { connectionId, profile }
    const queue = [sessionId]
    const seen = new Set(queue)
    const rows: StoredSubagent[] = []
    let requests = 0
    // First read of this owner paints page by page; a reload publishes once, so loaded rows never flicker.
    // `result` is this render's committed state: a Retry of the same owner starts from its rows.
    const progressive = result.key !== key
    const previousRows = progressive ? [] : result.rows
    const publish = (next: StoredSubagent[], status: StoredSubagentsStatus) => setResult({ key, rows: next, status })

    publish(previousRows, 'loading')

    const load = async (): Promise<StoredSubagentsStatus> => {
      while (queue.length && rows.length < MAX_SUBAGENTS && requests < MAX_REQUESTS && !cancelled) {
        const parentId = queue.shift()!
        let offset = 0
        let more = true

        while (more && rows.length < MAX_SUBAGENTS && requests < MAX_REQUESTS && !cancelled) {
          let page

          try {
            requests += 1
            page = await listSessionSubagents(parentId, scope, { limit: Math.min(PAGE_SIZE, MAX_SUBAGENTS - rows.length), offset })
          } catch (error) {
            // Only the backend's catch-all proves the route is absent; a handler 404 (unknown
            // session) or any transient failure is not a capability verdict.
            if (isUnroutedRestPath(error)) {
              markSubagentListingRouteMissing(capabilityKey)
              rows.length = 0

              return 'unsupported'
            }

            return 'failed'
          }

          if (cancelled) {return 'idle'}
          const children: SessionInfo[] = []

          for (const child of page.sessions) {
            if (seen.has(child.id) || rows.length >= MAX_SUBAGENTS) {continue}
            seen.add(child.id)
            children.push(child)
            rows.push({ parentId, session: child })

            if ((child.subagent_count ?? 0) > 0) {queue.push(child.id)}
          }

          // Exact-id identity only: an opened row is recognized as a read-only subagent page.
          children.forEach(rememberSubagentPage)

          if (progressive) {
            publish([...rows], 'loading')
          }

          const next = page.offset + page.sessions.length
          more = page.has_more && page.sessions.length > 0 && next > offset
          offset = next
        }
      }

      return 'ready'
    }

    void load().then(status => {
      if (!cancelled) {
        // A failed reload keeps what an earlier read proved rather than blanking the list.
        publish(status === 'failed' && previousRows.length > rows.length ? previousRows : [...rows], status)
      }
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadKey covers key + attempt; result is read once per load
  }, [loadKey, sessionId, profile, connectionId, hasOwner, capabilityKey])

  const current = result.key === key

  return {
    retry: () => setAttempt(value => value + 1),
    rows: current ? result.rows : [],
    status: current ? result.status : sessionId && hasOwner ? 'loading' : 'idle'
  }
}

const ROUTE_DEFAULTS: SubagentRoute = {
  provider: null,
  model: null,
  requested_effort: null,
  wire_effort: null,
  effective_effort: null,
  effort_source: 'unknown',
  reasoning_status: 'unknown',
  fallback_activated: null,
  observed: false
}

/** What a stored child proves after a reload: the persisted observation's route and ending when the
 *  backend projects one, else only the launch model and the session's end reason. Effort and
 *  fallback are never guessed from launch config. */
function storedOutcome(session: SessionInfo): Pick<SubagentProgress, 'durationSeconds' | 'model' | 'route' | 'status'> {
  const observed = session.subagent_observation
  const route = observed?.route ? { ...ROUTE_DEFAULTS, ...observed.route } : undefined
  const ended = session.ended_at != null

  const budget =
    session.end_reason === 'subagent_timeout' ? 'timeout' : session.end_reason === 'subagent_max_iterations' ? 'max_iterations' : undefined

  const fromObservation = (): SubagentProgress['status'] | undefined => {
    switch (observed?.status) {
      case 'completed':

      case 'failed':

      case 'interrupted':
        return observed.status

      case 'timeout':

      case 'error':
        return 'failed'

      case 'cancelled':

      case 'canceled':
        return 'interrupted'

      default:
        return undefined
    }
  }

  // A row still open is running whatever the last checkpoint said; an ended row whose last
  // checkpoint is still "running" (process died mid-run) falls back to its end reason.
  const status: SubagentProgress['status'] = !ended ? 'running' : (fromObservation() ?? (budget ? 'failed' : 'completed'))

  return {
    durationSeconds: observed?.duration_seconds ?? undefined,
    model: route?.model || session.model || undefined,
    route,
    status
  }
}

/** Live records win, including their runtime ids and authoritative status. */
export function mergeStoredSubagents(live: SubagentProgress[], stored: StoredSubagent[]): SubagentProgress[] {
  const bySession = new Map(live.filter(row => row.sessionId).map(row => [row.sessionId!, row.id]))
  const alreadyLive = new Set<string>()

  for (const { session } of stored) {
    const aliases = [session.id, session._lineage_root_id, ...(session._lineage_ids ?? [])]
    const liveId = aliases.map(id => id && bySession.get(id)).find(Boolean)

    if (liveId) {alreadyLive.add(session.id)}
    bySession.set(session.id, liveId || `stored:${session.id}`)
  }

  const recovered = stored.filter(({ session }) => !alreadyLive.has(session.id)).map(({ parentId, session }) => ({
    id: bySession.get(session.id)!,
    parentId: bySession.get(parentId) ?? null,
    parentSessionId: parentId,
    sessionId: session.id,
    goal: session.preview || session.title || session.id,
    ...storedOutcome(session),
    taskCount: 1,
    taskIndex: 0,
    startedAt: session.started_at * 1000,
    updatedAt: session.last_active * 1000,
    inputTokens: session.input_tokens,
    outputTokens: session.output_tokens,
    toolCount: session.tool_call_count,
    filesRead: [],
    filesWritten: [],
    stream: []
  }))

  return [...recovered, ...live]
}
