import { act, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  request: vi.fn(),
  clear: vi.fn(),
  owner: { profile: 'default', connectionId: 'local' }
}))

vi.mock('@/store/session', () => ({
  // A real subagent row: a parent link alone no longer makes a subagent page (R01).
  $sessions: atom([{ id: 'child', parent_session_id: 'parent', _delegate_from: 'parent', source: 'subagent' }]),
  sessionMatchesStoredId: (s: { id: string }, id: string) => s.id === id
}))
vi.mock('@/store/session-states', () => ({
  requestForOwnedSession: mocked.request,
  knownOwnerForSession: () => mocked.owner
}))
vi.mock('@/store/subagent-unread', () => ({ clearSubagentUnreadOnOpen: mocked.clear }))
vi.mock('@/store/windows', () => ({ isWatchWindow: () => false }))

import { useSubagentSubject } from './use-subagent-subject'

const finished = {
  available: false,
  parent_session_id: 'parent',
  subagent: { child_session_id: 'child', status: 'completed' }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.clear.mockResolvedValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

test('marks a subagent read only after its authorized subject mounts, never on an unproven open', async () => {
  let resolve!: (value: unknown) => void
  mocked.request.mockReturnValue(new Promise(done => (resolve = done)))
  const hook = renderHook(() => useSubagentSubject('child', 'child'))
  await waitFor(() => expect(mocked.request).toHaveBeenCalledOnce())
  expect(mocked.clear).not.toHaveBeenCalled()
  await act(async () => resolve(finished))
  await waitFor(() => expect(mocked.clear).toHaveBeenCalledWith('child', 'parent', mocked.owner))
  hook.rerender()
  expect(mocked.clear).toHaveBeenCalledOnce()
  hook.unmount()
})

test('a child seen before the user moves on is still acknowledged after the page unmounts', async () => {
  let resolve!: (value: unknown) => void
  mocked.request.mockReturnValue(new Promise(done => (resolve = done)))
  const hook = renderHook(() => useSubagentSubject('child', 'child'))
  await waitFor(() => expect(mocked.request).toHaveBeenCalledOnce())
  hook.unmount()
  await act(async () => resolve(finished))
  await waitFor(() => expect(mocked.clear).toHaveBeenCalledWith('child', 'parent', mocked.owner))
})

test('later polls of a running subagent never acknowledge newer work', async () => {
  vi.useFakeTimers()
  mocked.request.mockResolvedValue({
    ...finished,
    available: true,
    subagent: { ...finished.subagent, status: 'running' }
  })
  const hook = renderHook(() => useSubagentSubject('child', 'child'))
  await act(async () => vi.advanceTimersByTimeAsync(3500))
  expect(mocked.request.mock.calls.length).toBeGreaterThan(2)
  expect(mocked.clear).toHaveBeenCalledOnce()
  hook.unmount()
})

test('a refused read retries a bounded number of times', async () => {
  vi.useFakeTimers()
  mocked.clear.mockResolvedValue(false)
  mocked.request.mockResolvedValue(finished)
  const hook = renderHook(() => useSubagentSubject('child', 'child'))
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(mocked.clear).toHaveBeenCalledTimes(3)
  hook.unmount()
})
