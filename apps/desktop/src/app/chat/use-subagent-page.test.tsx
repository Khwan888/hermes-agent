import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { $sessions } from '@/store/session'
import { $resolvedSubagentPages, rememberSubagentPage } from '@/store/subagent-session-cache'
import type { SessionInfo } from '@/types/hermes'

import { transcriptRuntimeActions, useSubagentPage } from './use-subagent-page'

const state = vi.hoisted(() => ({ owner: { connectionId: 'local', profile: 'default' }, watch: false }))
vi.mock('@/store/session-states', () => ({ knownOwnerForSession: () => state.owner }))
vi.mock('@/store/windows', async original => ({ ...(await original<object>()), isWatchWindow: () => state.watch }))

const row = (fields: Partial<SessionInfo>) => ({ id: 'child', profile: 'default', ...fields }) as SessionInfo

afterEach(() => {
  cleanup()
  $sessions.set([])
  $resolvedSubagentPages.set({})
  state.owner = { connectionId: 'local', profile: 'default' }
  state.watch = false
})

test.each([
  { _branched_from: 'parent' },
  { _reset_from: 'parent' },
  { source: 'cli' }
])('a parent-linked ordinary chat is not a read-only subagent page: %j', fields => {
  $sessions.set([row({ parent_session_id: 'parent', ...fields })])
  expect(renderHook(() => useSubagentPage('child')).result.current).toBe(false)
})

test('a resolved real child stays read-only off-list, but never for a twin on another owner', () => {
  rememberSubagentPage(row({ is_internal_child: true, parent_session_id: 'parent' }))
  const hook = renderHook(() => useSubagentPage('child'))
  expect(hook.result.current).toBe(true)
  hook.unmount()
  state.owner = { connectionId: 'remote', profile: 'default' }
  expect(renderHook(() => useSubagentPage('child')).result.current).toBe(false)
  expect($sessions.get()).toEqual([])
})

test('an explicit watch window remains read-only even before identity resolves', () => {
  state.watch = true
  expect(renderHook(() => useSubagentPage(null)).result.current).toBe(true)
})

test('subagent runtime disables editing, reload, message mutation and cancellation', () => {
  const onEdit = vi.fn()
  const actions = transcriptRuntimeActions({ readOnly: true, historical: false, onEdit, onReload: vi.fn(), onCancel: vi.fn(), onThreadMessagesChange: vi.fn() })
  expect(actions).toEqual({ isDisabled: true, setMessages: undefined, onEdit: undefined, onReload: undefined, onCancel: undefined })
  expect(transcriptRuntimeActions({ readOnly: false, historical: false, onEdit, onReload: vi.fn(), onCancel: vi.fn(), onThreadMessagesChange: vi.fn() }).onEdit).toBe(onEdit)
})
