import { useStore } from '@nanostores/react'

import { Backdrop } from '@/components/Backdrop'
import { useI18n } from '@/i18n'

import { useSessionView } from './session-view'
import { useSubagentPage } from './use-subagent-page'

export function SubagentBackdrop() {
  const storedId = useStore(useSessionView().$storedId)
  const subagentPage = useSubagentPage(storedId)
  const { t } = useI18n()

  return <>
    <Backdrop />
    {subagentPage && <div className="px-4 py-2 text-sm text-muted-foreground" data-slot="subagent-read-only">{t.assistant.tool.delegateReadOnly}</div>}
  </>
}
