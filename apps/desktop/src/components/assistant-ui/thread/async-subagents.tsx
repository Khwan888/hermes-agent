import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { locateSubagent, openSubagent, type SubagentLocation } from '@/app/open-subagent'
import { useI18n } from '@/i18n'
import type { ChatMessage } from '@/lib/chat-messages'
import { knownOwnerForSession } from '@/store/session-states'

import { delegateRowsFromCall } from '../tool/delegate-model'
import { parseMaybeObject } from '../tool/fallback-model'

interface SubagentAction extends SubagentLocation {
  goal: string
  parentSessionId: string
}

function dispatchCall(messages: ChatMessage[], delegationId: string) {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool-call' || part.toolName !== 'delegate_task') {
        continue
      }

      const result = parseMaybeObject(part.result)
      const units = Array.isArray(result.units) ? result.units.map(parseMaybeObject) : []

      if (result.delegation_id === delegationId || units.some(unit => unit.delegation_id === delegationId)) {
        return part
      }
    }
  }

  return null
}

/** Resolve only the tasks of this persisted dispatch, never a goal-text guess. */
export function AsyncSubagents({ delegationId }: { delegationId: string }) {
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)
  const storedId = useStore(view.$storedId)
  const messages = useStore(view.$messages)
  const { t } = useI18n()
  const [actions, setActions] = useState<SubagentAction[]>([])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const call = dispatchCall(messages, delegationId)

  // These are remote reads with a captured session owner, not a store mirror.
  useEffect(() => {
    let current = true
    const parentId = storedId || runtimeId
    const owner = knownOwnerForSession(parentId)
    setActions([])
    setFailed(false)

    if (!call || !runtimeId || !parentId || !owner) {
      return
    }

    const load = async () => {
      const found: SubagentAction[] = []
      const seen = new Set<string>([parentId])

      const add = async (action: SubagentAction) => {
        if (seen.has(action.sessionId)) {
          return
        }

        seen.add(action.sessionId)
        found.push(action)

        // Publish proven links even if a later descendant read fails.
        if (current) {
          setActions([...found])
        }

      }

      let incomplete = false

      for (const row of delegateRowsFromCall(call.args, call.result, call.toolCallId)) {
        if (!current) {
          return
        }

        const located = await locateSubagent(runtimeId, call.toolCallId ?? '', row.taskIndex)
        const location = located ?? (row.sessionId ? { sessionId: row.sessionId, running: true } : null)

        if (location) {
          try {
            await add({ ...location, goal: row.goal, parentSessionId: parentId })
          } catch {
            incomplete = true
          }
        } else {
          incomplete = true
        }
      }

      if (current) {
        setFailed(incomplete)
      }
    }

    void load().catch(() => {
      if (current) {
        setFailed(true)
      }
    })

    return () => {
      current = false
    }
  }, [call, runtimeId, storedId, attempt])

  return (
    <div className="mb-2 flex flex-col items-start gap-1">
      {actions.map(action => (
        <button
          className="text-left text-sm text-muted-foreground hover:text-foreground"
          data-parent-session-id={action.parentSessionId}
          data-session-id={action.sessionId}
          data-subagent-open=""
          data-subagent-status={action.running ? 'running' : 'completed'}
          key={action.sessionId}
          onClick={() =>
            openSubagent(
              { sessionId: action.sessionId, running: action.running },
              { parentSessionId: action.parentSessionId }
            )
          }
          type="button"
        >
          {action.goal}
        </button>
      ))}
      {failed && (
        <button onClick={() => setAttempt(value => value + 1)} type="button">
          {t.common.retry}
        </button>
      )}
    </div>
  )
}
