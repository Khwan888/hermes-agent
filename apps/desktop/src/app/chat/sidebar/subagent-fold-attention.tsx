import { useI18n } from '@/i18n'
import { resolveSubagentAttention } from '@/lib/subagent-attention'
import { sessionSubagentAttention } from '@/lib/subagent-attention-rollup'
import { useStoresSelector } from '@/lib/use-session-slice'
import { $liveWorkRoster } from '@/store/live-work-roster'
import { $subagentReadOverrides, $subagentSessionRows, subagentReadView } from '@/store/subagent-session-cache'
import { $subagentsBySession } from '@/store/subagents'
import type { SessionInfo } from '@/types/hermes'

import { sessionDotClassName } from '../session-status-dot'

export function useSubagentFoldAttention(owner: SessionInfo) {
  const { t } = useI18n()

  const encoded = useStoresSelector(
    [$subagentsBySession, $liveWorkRoster, $subagentReadOverrides, $subagentSessionRows],
    () => {
      const result = resolveSubagentAttention(
        sessionSubagentAttention(subagentReadView(owner), $subagentsBySession.get(), $liveWorkRoster.get())
      )

      return result ? `${result.state}:${result.count}` : ''
    }
  )

  const [state, count] = encoded.split(':')
  const attention = state as 'waiting' | 'stuck' | 'over_budget' | 'unread' | undefined
  const label = attention ? t.agents.attention.count(Number(count), t.agents.attention[attention]) : undefined

  return {
    attention: attention || undefined,
    label,
    dot: attention ? (
      <span aria-hidden className={sessionDotClassName(attention === 'unread' ? 'unread' : 'needs-input')} />
    ) : null
  }
}
