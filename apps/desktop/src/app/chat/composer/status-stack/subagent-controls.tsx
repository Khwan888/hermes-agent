import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { requestForOwnedSession } from '@/store/session-states'

interface SubagentControlsProps {
  sessionId: string
  subagentId: string
  text: string
  setText: (text: string) => void
}

export function SubagentControls({ sessionId, subagentId, text, setText }: SubagentControlsProps) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [failed, setFailed] = useState(false)
  const [lastSteer, setLastSteer] = useState('')

  const send = async (action: 'steer' | 'interrupt') => {
    setPending(true)
    setFeedback('')
    setFailed(false)

    try {
      // Unlike global chrome, a child control must NEVER fall back to whichever
      // gateway happens to be active, even on a legacy unbound session.
      const result = await requestForOwnedSession<{
        found?: boolean
        status?: string
        delivered_at?: number | null
        relayed_to?: unknown[]
      }>(
        sessionId,
        async () => {
          throw new Error(t.agents.requestRejected)
        },
        `subagent.${action}`,
        { session_id: sessionId, subagent_id: subagentId, ...(action === 'steer' ? { text: text.trim() } : {}) }
      )

      if (action === 'steer' ? result.status !== 'queued' : !result.found) {
        throw new Error(t.agents.requestRejected)
      }

      const delivered = result.delivered_at != null
      const relayed = Array.isArray(result.relayed_to) ? result.relayed_to.length : 0
      setFeedback(
        action === 'steer'
          ? delivered
            ? [
                t.agents.steerDelivered,
                ...(relayed ? [t.agents.steerRelayed.replace('{count}', String(relayed))] : [])
              ].join(' · ')
            : t.agents.steerQueued
          : t.agents.stopRequested
      )

      if (action === 'steer') {
        setLastSteer(text.trim())
        setText('')
      }
    } catch {
      setFailed(true)
      setFeedback(t.agents.requestRejected)
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="grid gap-1 pb-3"
      onKeyDown={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault()
        event.stopPropagation()

        if (text.trim() && !pending) {
          void send('steer')
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Input
          aria-label={t.agents.steerPlaceholder}
          disabled={pending}
          onChange={event => setText(event.target.value)}
          placeholder={t.agents.steerPlaceholder}
          value={text}
        />
        <Button disabled={pending || !text.trim()} size="xs" type="submit" variant="secondary">
          {t.agents.steer}
        </Button>
        <Button disabled={pending} onClick={() => void send('interrupt')} size="xs" type="button" variant="text">
          {t.statusStack.stop}
        </Button>
      </div>
      {lastSteer && (
        <p className="text-xs text-(--ui-text-secondary)" data-subagent-steer="">
          <span>{t.agents.steerLabel}: </span>
          {lastSteer}
        </p>
      )}
      {feedback && (
        <p className="text-xs text-(--ui-text-secondary)" role={failed ? 'alert' : 'status'}>
          {feedback}
        </p>
      )}
    </form>
  )
}
