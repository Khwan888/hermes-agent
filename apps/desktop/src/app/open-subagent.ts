import { $gatewayActivationEpoch } from '@/store/gateway-activation-epoch'
import { notify } from '@/store/notifications'
import { setSessionOwnerHint } from '@/store/session'
import { knownOwnerForSession, requestForOwnedSession } from '@/store/session-states'
/**
 * One door for "open this subagent" — the delegate card and the Agents rows.
 *
 * A finished subagent opens as its full page: the stored child session in a
 * session tab beside the parent (the same page sidebar search opens; the
 * parent stays where it was). A RUNNING subagent opens read-only in a watch
 * window instead: its session is still being written by the child agent the
 * parent runs, and a full page would offer a composer whose send starts a
 * second turn on it. A watch window has no workspace to stack a tab in, so a
 * subagent opened from one (a nested subagent's card) watches too.
 *
 * A stored card often has no subagent id left in the renderer: the live store
 * forgets a child when it finishes, and a reload or restart forgets them all.
 * Its `delegate_task` call still knows them — `subagent.locate` answers which
 * stored subagent ran each task (a resolved finished child is cached per owner
 * and call; a failed, empty, unresolved or still-running lookup is re-asked).
 */
import { isWatchWindow, openSessionInNewWindow } from '@/store/windows'

import { openSession } from './open-session'

export interface SubagentLocation {
  running: boolean
  sessionId: string
}

interface LocatedChild {
  child_session_id?: null | string
  running?: boolean
  task_index: number
}

const rejectUnowned = async <T>(): Promise<T> => {
  throw new Error('Subagent owner unavailable')
}

const located = new Map<string, Promise<LocatedChild[]>>()
const LOCATE_CACHE_LIMIT = 200
$gatewayActivationEpoch.subscribe(() => located.clear())

/** The same runtime id can name a twin session on another connection/profile. */
function ownerKey(sessionId: string): string {
  const owner = knownOwnerForSession(sessionId)

  return typeof owner === 'string'
    ? owner
    : owner
      ? `${owner.connectionId}\u0000${owner.targetProfile || owner.profile}`
      : ''
}

/** Which stored subagent ran task `taskIndex` of call `toolCallId` in `sessionId`
 *  (the parent's runtime id), or null when the backend can't prove one. */
export async function locateSubagent(
  sessionId: string,
  toolCallId: string,
  taskIndex: number
): Promise<SubagentLocation | null> {
  if (!sessionId || !toolCallId) {
    return null
  }

  const owner = ownerKey(sessionId)
  const epoch = $gatewayActivationEpoch.get()
  const key = `${epoch}\u0000${owner}\u0000${sessionId}\u0000${toolCallId}`
  let pending = located.get(key)

  if (!pending) {
    pending = requestForOwnedSession<{ children?: LocatedChild[] }>(sessionId, rejectUnowned, 'subagent.locate', {
      session_id: sessionId,
      tool_call_id: toolCallId
    }).then(result => (Array.isArray(result?.children) ? result.children : []))
    located.set(key, pending)

    // Bounded: drop the oldest calls first (Map keeps insertion order).
    for (const oldest of located.keys()) {
      if (located.size <= LOCATE_CACHE_LIMIT) {
        break
      }

      located.delete(oldest)
    }
  }

  try {
    const children = await pending

    if (ownerKey(sessionId) !== owner || $gatewayActivationEpoch.get() !== epoch) {
      located.delete(key)

      return null
    }

    const child = children.find(entry => entry.task_index === taskIndex)

    // Only a resolved finished child is final. A still-running child's flag goes
    // stale, and an unresolved task may be persisted later: both are re-asked.
    if (!child?.child_session_id || child.running) {
      located.delete(key)
    }

    return child?.child_session_id ? { running: Boolean(child.running), sessionId: child.child_session_id } : null
  } catch {
    located.delete(key)

    return null
  }
}

export function openSubagent(subagent: SubagentLocation, opts: { parentSessionId?: null | string } = {}): void {
  const owner = knownOwnerForSession(opts.parentSessionId)

  if (owner && typeof owner !== 'string') {
    setSessionOwnerHint(subagent.sessionId, owner)
  }

  if (subagent.running || isWatchWindow()) {
    void openSessionInNewWindow(subagent.sessionId, { parentSessionId: opts.parentSessionId, watch: true })

    return
  }

  openSession(subagent.sessionId, () => undefined, 'tab')
}

/** Open the subagent a card row names, locating it through its call when the row
 *  has no session id — or no idea whether it still runs (`running` undefined: a
 *  parked background row; unproven, it watches rather than offer a composer).
 *  Tells the user when no stored subagent can be found. */
export async function openSubagentForCall(input: {
  missingMessage: string
  parentRuntimeId: null | string
  parentSessionId: null | string
  running: boolean | undefined
  sessionId?: string
  taskIndex: number
  toolCallId?: string
}): Promise<boolean> {
  const known = input.sessionId && input.running !== undefined

  const found = known
    ? null
    : await locateSubagent(input.parentRuntimeId ?? '', input.toolCallId ?? '', input.taskIndex)

  const subagent: SubagentLocation | null = known
    ? { running: Boolean(input.running), sessionId: input.sessionId! }
    : (found ?? (input.sessionId ? { running: true, sessionId: input.sessionId } : null))

  if (!subagent) {
    notify({ kind: 'info', message: input.missingMessage })

    return false
  }

  openSubagent(subagent, { parentSessionId: input.parentSessionId })

  return true
}
