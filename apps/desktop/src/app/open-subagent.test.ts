import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  owner: { connectionId: 'local', profile: 'default' } as { connectionId: string; profile: string },
  request: vi.fn()
}))

vi.mock('@/store/session-states', () => ({
  knownOwnerForSession: () => state.owner,
  requestForOwnedSession: state.request
}))
vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/windows', () => ({ isWatchWindow: () => false, openSessionInNewWindow: vi.fn() }))
vi.mock('./open-session', () => ({ openSession: vi.fn() }))

import { $gatewayActivationEpoch } from '@/store/gateway-activation-epoch'

import { locateSubagent } from './open-subagent'

let call = 0

beforeEach(() => {
  vi.clearAllMocks()
  state.owner = { connectionId: 'local', profile: 'default' }
  // Unique call ids per test: the cache is module state.
  call += 1
})

test('an unresolved first answer is re-asked, so a child persisted later still opens', async () => {
  state.request
    .mockResolvedValueOnce({ children: [] })
    .mockResolvedValueOnce({ children: [{ task_index: 0, child_session_id: 'child-a', running: false }] })

  await expect(locateSubagent('parent', `call-${call}`, 0)).resolves.toBeNull()
  await expect(locateSubagent('parent', `call-${call}`, 0)).resolves.toEqual({ running: false, sessionId: 'child-a' })
  expect(state.request).toHaveBeenCalledTimes(2)
})

test('a resolved finished child is cached per owner, never reused for a twin id on another owner', async () => {
  state.request
    .mockResolvedValueOnce({ children: [{ task_index: 0, child_session_id: 'local-child', running: false }] })
    .mockResolvedValueOnce({ children: [{ task_index: 0, child_session_id: 'remote-child', running: false }] })

  await expect(locateSubagent('twin', `call-${call}`, 0)).resolves.toEqual({ running: false, sessionId: 'local-child' })
  await expect(locateSubagent('twin', `call-${call}`, 0)).resolves.toEqual({ running: false, sessionId: 'local-child' })
  expect(state.request).toHaveBeenCalledTimes(1)

  state.owner = { connectionId: 'remote', profile: 'default' }
  await expect(locateSubagent('twin', `call-${call}`, 0)).resolves.toEqual({
    running: false,
    sessionId: 'remote-child'
  })
  expect(state.request).toHaveBeenCalledTimes(2)
})

test('backend activation invalidates a finished locate cache', async () => {
  state.request.mockResolvedValue({ children: [{ task_index: 0, child_session_id: 'before', running: false }] })
  await locateSubagent('parent', `call-${call}`, 0)
  $gatewayActivationEpoch.set($gatewayActivationEpoch.get() + 1)
  state.request.mockResolvedValue({ children: [{ task_index: 0, child_session_id: 'after', running: false }] })
  await expect(locateSubagent('parent', `call-${call}`, 0)).resolves.toEqual({ sessionId: 'after', running: false })
  expect(state.request).toHaveBeenCalledTimes(2)
})
