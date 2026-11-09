import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import {
  $resolvedSubagentPages,
  rememberSubagentPage
} from '@/store/subagent-session-cache'
import type { SessionInfo } from '@/types/hermes'

import { useSubagentSubject } from './use-subagent-subject'

const { request, owner } = vi.hoisted(() => ({
  request: vi.fn(),
  owner: vi.fn<(id: string) => unknown>(() => ({ connectionId: 'local', profile: 'default' }))
}))

vi.mock('@/store/session-states', () => ({ knownOwnerForSession: owner, requestForOwnedSession: request }))
vi.mock('@/store/windows', () => ({ isWatchWindow: () => false }))
vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')

  return {
    $sessions: atom([
      { id: 'parent', source: 'desktop' },
      // "Branch in new chat" writes a parent link and _branched_from (use-session-actions/utils.ts).
      { id: 'branch', parent_session_id: 'parent', _branched_from: 'parent', source: 'desktop' },
      // A compression rotation's tip links to the segment it continues.
      { id: 'rotated-tip', parent_session_id: 'rotated-root', _lineage_root_id: 'rotated-root', source: 'tui' },
      // /new resets carry the old session as parent too.
      { id: 'reset', parent_session_id: 'parent', _reset_from: 'parent', source: 'desktop' },
      { id: 'subagent', parent_session_id: 'parent', _delegate_from: 'parent', source: 'subagent' }
    ]),
    sessionMatchesStoredId: (row: { id: string; _lineage_root_id?: string }, id: string) =>
      row.id === id || row._lineage_root_id === id
  }
})

const child = (profile: string) =>
  ({ id: 'cached-child', is_internal_child: true, profile, connection_id: 'local' }) as unknown as SessionInfo

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  request.mockReset()
  owner.mockReset()
  owner.mockReturnValue({ connectionId: 'local', profile: 'default' })
  $resolvedSubagentPages.set({})
})

it('adds neither a subagent surface nor polling to the parent main page', () => {
  const { result } = renderHook(() => useSubagentSubject('parent-runtime', 'parent'))
  expect(result.current.subagentPage).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

it.each([
  ['a branched ordinary chat', 'branch'],
  ['a rotated ordinary chat', 'rotated-tip'],
  ['a rotated chat opened by its lineage root', 'rotated-root'],
  ['a reset ordinary chat', 'reset']
])('keeps %s a writable chat, not a subagent page', (_label, storedId) => {
  const { result } = renderHook(() => useSubagentSubject(`${storedId}-runtime`, storedId))
  expect(result.current.subagentPage).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

it('treats a listed delegate child as a subagent page', () => {
  request.mockReturnValue(new Promise(() => undefined))
  const { result } = renderHook(() => useSubagentSubject('child-runtime', 'subagent'))
  expect(result.current.subagentPage).toBe(true)
  expect(request).toHaveBeenCalledTimes(1)
})

it('recognises an unlisted child from the subagent cache of the same owner only', () => {
  request.mockReturnValue(new Promise(() => undefined))
  owner.mockReturnValue({ connectionId: 'local', profile: 'default' })
  rememberSubagentPage(child('work'))

  const { result, rerender } = renderHook(() => useSubagentSubject('cached-runtime', 'cached-child'))
  expect(result.current.subagentPage).toBe(false)

  act(() => rememberSubagentPage(child('default')))
  rerender()
  expect(result.current.subagentPage).toBe(true)
})

it('recognises a child opened by exact id', () => {
  request.mockReturnValue(new Promise(() => undefined))
  owner.mockReturnValue({ connectionId: 'local', profile: 'default' })
  const { result, rerender } = renderHook(() => useSubagentSubject('cached-runtime', 'cached-child'))
  expect(result.current.subagentPage).toBe(false)
  act(() => rememberSubagentPage(child('default')))
  rerender()
  expect(result.current.subagentPage).toBe(true)
})

it('keeps failed subagent reads distinct from completion and stops after bounded retries', async () => {
  vi.useFakeTimers()
  request.mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() => useSubagentSubject('child-runtime', 'subagent'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(request).toHaveBeenCalledTimes(3)
  expect(result.current.unavailable).toBe(true)
  act(() => result.current.retry())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(request).toHaveBeenCalledTimes(4)
})
