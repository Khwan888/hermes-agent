import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $subagentsBySession } from '@/store/subagents'

import { SubagentPageBar } from './subagent-page-bar'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/store/session-states', () => ({
  knownOwnerForSession: () => ({ profile: 'default' }),
  requestForOwnedSession: request
}))

afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
  request.mockReset()
})

it('hydrates live nested cards in a read-only subagent viewer without mounting a composer', async () => {
  request.mockResolvedValue({
    subagents: [
      {
        subagent_id: 'gamma',
        child_session_id: 'stored-gamma',
        goal: 'nested check',
        status: 'running'
      }
    ]
  })

  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <SubagentPageBar
        parentSessionId="parent"
        running
        sessionId="beta-viewer"
        storedSessionId="stored-beta"
        subject={{ subagent_id: 'beta', status: 'running' }}
      />
    </I18nProvider>
  )

  await waitFor(() => expect($subagentsBySession.get()['beta-viewer']?.[0]?.sessionId).toBe('stored-gamma'))
  expect(request).toHaveBeenCalledWith('beta-viewer', expect.any(Function), 'subagent.list', {
    session_id: 'beta-viewer'
  })
  expect(container.querySelector('[data-slot="composer-root"]')).toBeNull()
})
