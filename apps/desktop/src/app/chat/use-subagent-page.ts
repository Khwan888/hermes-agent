import type { AppendMessage, ThreadMessage } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { $sessions } from '@/store/session'
import { knownOwnerForSession } from '@/store/session-states'
import { $resolvedSubagentPages, isSubagentPageSession } from '@/store/subagent-session-cache'
import { isWatchWindow } from '@/store/windows'

export function useSubagentPage(storedId: null | string): boolean {
  const sessions = useStore($sessions)
  const cached = useStore($resolvedSubagentPages)

  return isWatchWindow() || isSubagentPageSession(storedId, sessions, cached, knownOwnerForSession(storedId))
}

export function transcriptRuntimeActions(options: {
  readOnly: boolean
  historical: boolean
  onThreadMessagesChange: (messages: readonly ThreadMessage[]) => void
  onEdit: (message: AppendMessage) => Promise<void>
  onCancel: () => Promise<void> | void
  onReload: (parentId: string | null) => Promise<void>
}) {
  const disabled = options.readOnly || options.historical

  return {
    isDisabled: disabled,
    setMessages: disabled ? undefined : options.onThreadMessagesChange,
    onEdit: options.readOnly ? undefined : options.onEdit,
    onCancel: disabled ? undefined : async () => options.onCancel(),
    onReload: disabled ? undefined : options.onReload
  }
}
