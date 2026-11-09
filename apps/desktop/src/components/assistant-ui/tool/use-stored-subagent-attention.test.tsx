import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { getSession } from '@/api/sessions'
import type * as Sessions from '@/api/sessions'
import {
  $subagentReadEpoch,
  $subagentReadOverrides,
  $subagentSessionRows,
  confirmSubagentRead
} from '@/store/subagent-session-cache'
import { makeSessionInfo } from '@/test/session-info'

import { useStoredSubagentAttention } from './use-stored-subagent-attention'

vi.mock('@/api/sessions', async original => ({ ...(await original<typeof Sessions>()), getSession: vi.fn() }))
vi.mock('@/store/session-states', () => ({
  knownOwnerForSession: () => ({ profile: 'default', connectionId: 'local' })
}))

const stored = (unread: boolean) =>
  makeSessionInfo({ id: 'child', ended_at: 10, end_reason: 'completed', is_internal_child: true, unread })

beforeEach(() => {
  vi.clearAllMocks()
  $subagentReadEpoch.set({})
  $subagentReadOverrides.set({})
  $subagentSessionRows.set({})
})

test('a parked card read before the child was acknowledged re-reads once the read is confirmed', async () => {
  vi.mocked(getSession).mockResolvedValueOnce(stored(true)).mockResolvedValueOnce(stored(false))
  const hook = renderHook(() => useStoredSubagentAttention('child', 'parent', true))
  await waitFor(() => expect(hook.result.current).toBe('unread'))
  act(() => confirmSubagentRead('child'))
  await waitFor(() => expect(hook.result.current).toBeUndefined())
  expect(getSession).toHaveBeenCalledTimes(2)
})
