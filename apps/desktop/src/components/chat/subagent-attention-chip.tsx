import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/i18n'
import type { SubagentAttention } from '@/lib/subagent-attention'

export function SubagentAttentionChip({ attention }: { attention?: SubagentAttention }) {
  const { t } = useI18n()

  return attention ? (
    <Badge size="xs" variant={attention === 'unread' ? 'muted' : 'warn'}>
      {t.agents.attention[attention]}
    </Badge>
  ) : null
}
