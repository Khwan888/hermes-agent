import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $queuedPromptsBySession, enqueueQueuedPrompt, getQueuedPrompts } from '@/store/composer-queue'
import { setSessionsLoading } from '@/store/session'
import type * as windows from '@/store/windows'

import { useBackgroundQueueDrain } from './use-background-queue-drain'

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof windows>()),
  isWatchWindow: () => true
}))
afterEach(() => {
  cleanup()
  $queuedPromptsBySession.set({})
  setSessionsLoading(true)
})
it('a subagent watch window never consumes another window’s queued prompts', () => {
  window.localStorage.removeItem('hermes.desktop.composerQueue.v1')
  setSessionsLoading(false)
  const entry = enqueueQueuedPrompt('background', { text: 'must stay queued', attachments: [] })!
  const submitText = vi.fn(() => true)
  renderHook(() =>
    useBackgroundQueueDrain({
      enabled: true,
      selectedStoredSessionId: 'helper',
      runtimeIdByStoredSessionIdRef: { current: new Map([['background', 'background-runtime']]) },
      submitText
    })
  )
  expect(submitText).not.toHaveBeenCalled()
  expect(getQueuedPrompts('background').map(item => item.id)).toContain(entry.id)
})
