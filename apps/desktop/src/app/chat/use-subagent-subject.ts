import type { SubagentSnapshot, SubagentSubjectResult } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $sessions, sessionMatchesStoredId } from '@/store/session'
import { knownOwnerForSession, requestForOwnedSession } from '@/store/session-states'
import { clearSubagentUnreadOnOpen } from '@/store/subagent-unread'
import { isWatchWindow } from '@/store/windows'

import { useSubagentPage } from './use-subagent-page'

const READ_ATTEMPTS = 3

interface SubagentSubjectState {
  subject: SubagentSnapshot | null
  parentSessionId: string | null
  running: boolean
  unavailable: boolean
}

/** Poll only subagent surfaces. Each poll measures the original child, not the lazy viewer. */
export function useSubagentSubject(sessionId: string | null, storedId: string | null) {
  const sessions = useStore($sessions)
  const row = sessions.find(session => storedId && sessionMatchesStoredId(session, storedId))
  const subagentPage = useSubagentPage(storedId)

  const [retryKey, setRetryKey] = useState(0)

  const [state, setState] = useState<SubagentSubjectState & { key: string | null }>({
    key: null,
    subject: null,
    parentSessionId: null,
    unavailable: false,
    running: isWatchWindow()
  })

  useEffect(() => {
    if (!subagentPage || !sessionId) {
      return
    }

    let active = true
    let failures = 0
    let again = true
    let read = false
    let timer: ReturnType<typeof setTimeout>

    // The backend authorizes a child's read-state write only once this page has mounted it, so a
    // click-time PATCH is refused (403). Mark read from the opened page after its subject resolves,
    // once: later background polls must not acknowledge newer work. The child was seen, so the
    // write completes even if the user has already moved on; a refused write retries briefly and
    // otherwise leaves the unread flag visible for the next open.
    const owner = knownOwnerForSession(sessionId)

    const markRead = async (childId: string, parentId: string | null | undefined, attempt = 1) => {
      const done = await clearSubagentUnreadOnOpen(childId, parentId, owner)

      if (!done && attempt < READ_ATTEMPTS) {
        setTimeout(() => void markRead(childId, parentId, attempt + 1), 1000)
      }
    }

    const poll = async () => {
      try {
        const result = await requestForOwnedSession<SubagentSubjectResult>(
          sessionId,
          async () => {
            throw new Error('Subagent owner unavailable')
          },
          'subagent.subject',
          { session_id: sessionId }
        )

        failures = 0
        again = result.available

        if (!read && result.subagent) {
          read = true
          void markRead(
            storedId ?? result.subagent.child_session_id ?? sessionId,
            result.parent_session_id ?? row?.parent_session_id
          )
        }

        if (active) {
          setState(previous => ({
            key: sessionId,
            unavailable: false,
            subject: result.subagent ?? (previous.key === sessionId ? previous.subject : null),
            parentSessionId: result.parent_session_id ?? row?.parent_session_id ?? null,
            running:
              result.available === true &&
              (!result.subagent?.status || ['running', 'queued'].includes(result.subagent.status))
          }))
        }
      } catch {
        again = ++failures < 3

        // Older backends cannot resolve a subject. Keep the subagent read-only; no fallback prompt.
        if (active) {
          setState(previous => ({ ...previous, key: sessionId, unavailable: true }))
        }
      } finally {
        if (active && again) {
          timer = setTimeout(poll, 1000)
        }
      }
    }

    void poll()

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [subagentPage, sessionId, storedId, row?.parent_session_id, retryKey])

  return {
    subagentPage,
    unavailable: state.key === sessionId && state.unavailable,
    retry: () => setRetryKey(value => value + 1),
    subject: state.key === sessionId ? state.subject : null,
    parentSessionId: state.key === sessionId ? state.parentSessionId : (row?.parent_session_id ?? null),
    running: state.key === sessionId ? state.running : isWatchWindow()
  }
}
