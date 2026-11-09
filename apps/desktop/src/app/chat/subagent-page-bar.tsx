import { compactNumber, type SubagentSnapshot } from '@hermes/shared'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useViewedInterval } from '@/hooks/use-viewed-interval'
import { useI18n } from '@/i18n'
import { formatDuration } from '@/lib/statusbar'
import { subagentRouteSubtitle } from '@/lib/subagent-route'

import { SubagentControls } from './composer/status-stack/subagent-controls'
import { useSubagentSnapshot } from './composer/status-stack/use-subagent-snapshot'

interface SubagentPageBarProps {
  subject: SubagentSnapshot | null
  sessionId: string | null
  storedSessionId: string | null
  parentSessionId: string | null
  running: boolean
  unavailable?: boolean
  onRetry?: () => void
}

function subagentMetrics(subject: SubagentSnapshot | null, running: boolean, now: number, available: string) {
  const usage = subject?.usage
  const prompt = usage?.prompt_tokens

  // Input excludes cache on core's counters. Divide cache reads by ALL prompt tokens.
  const cache =
    prompt != null && prompt > 0 && usage?.cached_tokens != null
      ? `${Math.round((100 * usage.cached_tokens) / prompt)}%`
      : available

  const context =
    usage?.context_tokens != null
      ? `${compactNumber(usage.context_tokens)}${usage.context_window ? ` / ${compactNumber(usage.context_window)}` : ''}`
      : available

  const speed =
    usage?.tokens_per_second != null && usage.tokens_per_second > 0
      ? `${Math.round(usage.tokens_per_second)} t/s`
      : available

  const elapsed =
    !running && subject?.duration_seconds != null
      ? subject.duration_seconds * 1000
      : subject?.started_at
        ? now - subject.started_at * 1000
        : null

  return { cache, context, speed, elapsed }
}

function subagentDisplayStatus(subject: SubagentSnapshot | null, running: boolean) {
  if (running) {
    return subject?.status ?? 'running'
  }

  return subject?.status === 'running' ? 'completed' : (subject?.status ?? 'completed')
}

/** Read-only transcript, separate subject-scoped controls: never a second prompt into a child. */
export function SubagentPageBar({
  subject,
  sessionId,
  storedSessionId,
  parentSessionId,
  running,
  unavailable = false,
  onRetry
}: SubagentPageBarProps) {
  // Read-only viewers have no composer to hydrate their nested delegate cards.
  useSubagentSnapshot(sessionId, running)
  const { t } = useI18n()
  const a = t.agents
  const [text, setText] = useState('')
  const [now, setNow] = useState(Date.now)
  useViewedInterval(() => setNow(Date.now()), 1000, running)
  const available = a.metricUnavailable
  const { cache, context, speed, elapsed } = subagentMetrics(subject, running, now, available)

  const route = subagentRouteSubtitle(subject?.route ?? undefined, subject?.model ?? undefined, a)

  return (
    <section
      aria-label={a.subagentPage}
      className="shrink-0 border-t border-(--ui-stroke-tertiary) px-4 pt-2 text-xs text-(--ui-text-secondary)"
      data-parent-session-id={parentSessionId}
      data-session-id={storedSessionId}
      data-slot="subagent-page-bar"
      data-subagent-id={subject?.subagent_id}
      data-subagent-status={subagentDisplayStatus(subject, running)}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
        <bdi data-subagent-metric="route">{route.length ? route.join(' · ') : a.modelUnknown}</bdi>
        <span data-subagent-metric="timer">
          {a.subagentTimer} <bdi>{elapsed != null ? formatDuration(elapsed) : available}</bdi>
        </span>
        {/* The subagent page is where its diagnostics live, so they always show here, independent of
            the main statusbar's readout choices (which stay off by default on ordinary chats).
            Values are isolated (<bdi>) so units and model ids keep their order in RTL locales. */}
        <span data-subagent-metric="context">
          {a.subagentContext} <bdi>{context}</bdi>
        </span>
        <span data-subagent-metric="cache">
          {a.subagentCache} <bdi>{cache}</bdi>
        </span>
        <span data-subagent-metric="speed">
          {a.subagentSpeed} <bdi>{speed}</bdi>
        </span>
      </div>
      {running && !unavailable && subject?.subagent_id && sessionId ? (
        <SubagentControls
          key={subject.subagent_id}
          sessionId={sessionId}
          setText={setText}
          subagentId={subject.subagent_id}
          text={text}
        />
      ) : (
        <div className="flex items-center gap-2 pb-3">
          <p>{unavailable || running ? a.subagentUnavailable : a.subagentFinished}</p>
          {unavailable && onRetry && (
            <Button onClick={onRetry} size="xs" variant="text">
              {t.common.retry}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
