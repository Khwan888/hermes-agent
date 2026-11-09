import { useMemo } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { AlertCircle, Loader2 } from '@/lib/icons'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $subagentNeedsYou } from '@/store/subagent-needs-you'

import type { StatusbarItem } from '../statusbar-controls'

/** The only visibility exception: a live human wait, never finished history. */
export function useAgentsStatusbarItem(
  agentsOpen: boolean,
  openAgents: () => void,
  running: number,
  failed: number
): StatusbarItem {
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const count = useStoreSelector($subagentNeedsYou, value => value.count)
  const attention = useStoreSelector($subagentNeedsYou, value => value.state)

  return useMemo(
    () => ({
      id: 'agents',
      subagentAttention: attention,
      className: cn(
        agentsOpen && 'bg-accent/55 text-foreground',
        failed > 0 && 'text-destructive hover:text-destructive',
        count > 0 && 'text-amber-600 dark:text-amber-300'
      ),
      detail:
        count > 0
          ? t.agents.attention.needsYou(count)
          : running > 0
            ? copy.subagents(running)
            : failed > 0
              ? copy.failed(failed)
              : undefined,
      icon:
        count > 0 || failed > 0 ? (
          <AlertCircle className="size-3" />
        ) : running > 0 ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Codicon name="hubot" size="0.75rem" />
        ),
      label: copy.agents,
      onSelect: openAgents,
      title: agentsOpen ? copy.closeAgents : copy.openAgents,
      toggleLabel: copy.agents,
      variant: 'action'
    }),
    [agentsOpen, attention, copy, count, failed, openAgents, running, t.agents.attention]
  )
}
