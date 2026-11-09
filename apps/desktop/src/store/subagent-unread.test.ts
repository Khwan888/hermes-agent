import { beforeEach, expect, it, vi } from 'vitest'

import { getSession, setSessionUnreadRemote } from '@/api/sessions'
import type * as Sessions from '@/api/sessions'
import { subagentAttention } from '@/lib/subagent-attention'
import { makeSessionInfo } from '@/test/session-info'

import { $sessions } from './session'
import { onSessionsChanged } from './session-sync'
import { clearUnreadOnOpen } from './session-unread-remote'
import {
  $subagentReadOverrides,
  $subagentSessionRows,
  rememberSubagentSessions,
  subagentReadView
} from './subagent-session-cache'
import { clearSubagentUnreadOnOpen } from './subagent-unread'
import { $subagentsBySession, upsertSubagent } from './subagents'

vi.mock('@/api/sessions', async original => ({
  ...(await original<typeof Sessions>()),
  getSession: vi.fn(),
  setSessionUnreadRemote: vi.fn()
}))

const parent = makeSessionInfo({
  id: 'parent',
  profile: 'work',
  connection_id: 'remote',
  subagent_attention: { unread: 1, over_budget: 1 }
})

const child = makeSessionInfo({
  id: 'subagent',
  profile: 'work',
  connection_id: 'remote',
  _delegate_from: 'parent',
  is_internal_child: true,
  unread: true,
  end_reason: 'subagent_max_iterations'
})

beforeEach(() => {
  vi.clearAllMocks()
  $subagentReadOverrides.set({})
  $subagentSessionRows.set({})
  $sessions.set([parent])
  $subagentsBySession.set({})
  rememberSubagentSessions([child])
  vi.mocked(setSessionUnreadRemote).mockResolvedValue({ ok: true })
  vi.mocked(getSession).mockResolvedValue({ ...parent, subagent_attention: undefined })
})

it('standard open leaves a subagent to its mounted page, whose clear keeps the correct owner on both requests', async () => {
  // The backend refuses a child's read write until its page mounts it: the click path never PATCHes.
  await clearUnreadOnOpen('subagent')
  expect(setSessionUnreadRemote).not.toHaveBeenCalled()
  expect(subagentReadView(child).unread).toBe(true)
  await expect(clearSubagentUnreadOnOpen('subagent')).resolves.toBe(true)
  expect(setSessionUnreadRemote).toHaveBeenCalledWith('subagent', false, 'work', 'remote')
  expect(getSession).toHaveBeenCalledWith('parent', { profile: 'work', connectionId: 'remote' })
  expect(subagentReadView(child).unread).toBe(false)
  expect($sessions.get()[0].subagent_attention).toBeUndefined()
  expect($sessions.get()).toHaveLength(1)
})

it('rolls unread, budget, and parent attention back visibly on failed writes', async () => {
  upsertSubagent(
    'parent',
    { subagent_id: 'sa', child_session_id: 'subagent', status: 'completed', exit_reason: 'max_iterations' },
    true,
    'subagent.complete'
  )
  let reject!: (error: Error) => void
  vi.mocked(setSessionUnreadRemote).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  const operation = clearSubagentUnreadOnOpen('subagent')
  expect(subagentReadView(child).unread).toBe(false)
  expect(subagentAttention($subagentsBySession.get().parent[0])).toBeUndefined()
  reject(new Error('offline'))
  await expect(operation).resolves.toBe(false)
  expect(subagentReadView(child).unread).toBe(true)
  expect(subagentReadView(parent).subagent_attention).toEqual({ unread: 1, over_budget: 1 })
  expect(subagentAttention($subagentsBySession.get().parent[0])).toBe('over_budget')
  expect(getSession).not.toHaveBeenCalled()
})

it('coalesces simultaneous doors and keeps a read child read after the short write guard expires', async () => {
  let resolve!: (value: { ok: boolean }) => void
  vi.mocked(setSessionUnreadRemote).mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const first = clearSubagentUnreadOnOpen('subagent')
  const second = clearSubagentUnreadOnOpen('subagent')
  expect(setSessionUnreadRemote).toHaveBeenCalledTimes(1)
  resolve({ ok: true })
  await Promise.all([first, second])
  $subagentReadOverrides.set({})
  expect(subagentReadView(child).unread).toBe(false)
})

it('marks read again when a subagent finishes after an earlier open inside the write guard', async () => {
  await clearSubagentUnreadOnOpen('subagent')
  upsertSubagent(
    'parent',
    { subagent_id: 'sa', child_session_id: 'subagent', status: 'completed', exit_reason: 'max_iterations' },
    true,
    'subagent.complete'
  )
  await clearSubagentUnreadOnOpen('subagent')
  expect(setSessionUnreadRemote).toHaveBeenCalledTimes(2)
  expect(subagentAttention($subagentsBySession.get().parent[0])).toBeUndefined()
})

it('uses an explicit owner rather than a same-id subagent cached from another profile', async () => {
  const other = { ...child, profile: 'other' }
  rememberSubagentSessions([other])
  await clearSubagentUnreadOnOpen('subagent', 'parent', { profile: 'other', connectionId: 'remote' })
  expect(setSessionUnreadRemote).toHaveBeenCalledWith('subagent', false, 'other', 'remote')
  expect(subagentReadView(child).unread).toBe(true)
})

it('does not let an older ancestor refresh overwrite a newer open', async () => {
  const another = { ...child, id: 'second' }
  const owner = { ...parent, subagent_attention: { unread: 2, over_budget: 2 } }
  $sessions.set([owner])
  rememberSubagentSessions([another])
  let resolveOld!: (value: typeof owner) => void
  let startedOld!: () => void

  const oldStarted = new Promise<void>(resolve => {
    startedOld = resolve
  })

  vi.mocked(getSession)
    .mockImplementationOnce(() => {
      startedOld()

      return new Promise(resolve => {
        resolveOld = resolve
      })
    })
    .mockResolvedValueOnce({ ...owner, subagent_attention: undefined })
  const first = clearSubagentUnreadOnOpen('subagent')
  await oldStarted
  await clearSubagentUnreadOnOpen('second')
  resolveOld({ ...owner, subagent_attention: { unread: 1, over_budget: 1 } })
  await first
  expect($sessions.get()[0].subagent_attention).toBeUndefined()
})

it('refreshes every loaded ancestor of a grandchild, not only its direct parent', async () => {
  const middle = { ...child, subagent_attention: { unread: 1 }, unread: false }
  const nested = { ...child, id: 'nested', _delegate_from: 'subagent', end_reason: undefined }
  rememberSubagentSessions([middle, nested])
  await clearSubagentUnreadOnOpen('nested')
  expect(getSession).toHaveBeenCalledWith('subagent', { profile: 'work', connectionId: 'remote' })
  expect(getSession).toHaveBeenCalledWith('parent', { profile: 'work', connectionId: 'remote' })
})

it('walks to the root through a middle subagent that opening already put in the session list', async () => {
  // Opening beta lists it as an ordinary row: no subagent marker, no _delegate_from, only its parent link.
  const opened = makeSessionInfo({
    id: 'subagent',
    profile: 'work',
    connection_id: 'remote',
    source: 'subagent',
    parent_session_id: 'parent'
  })

  const nested = { ...child, id: 'nested', _delegate_from: 'subagent', end_reason: undefined }
  $sessions.set([parent, opened])
  rememberSubagentSessions([nested])
  await clearSubagentUnreadOnOpen('nested')
  expect(getSession).toHaveBeenCalledWith('parent', { profile: 'work', connectionId: 'remote' })
})

it('asks the session list to re-pull after the write, so a page fetched before it cannot win', async () => {
  const refresh = vi.fn()
  const stop = onSessionsChanged(refresh)

  try {
    await clearSubagentUnreadOnOpen('subagent')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.mocked(setSessionUnreadRemote).mockRejectedValueOnce(new Error('offline'))
    $subagentReadOverrides.set({})
    await clearSubagentUnreadOnOpen('subagent')
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    stop()
  }
})
