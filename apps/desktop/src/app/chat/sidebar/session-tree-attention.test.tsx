import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { getSession, listSessionSubagents, setSessionUnreadRemote } from '@/api/sessions'
import type * as Sessions from '@/api/sessions'
import { $liveWorkRoster, setLiveWorkRosterSource } from '@/store/live-work-roster'
import { $sessions } from '@/store/session'
import { $expandedSessionSubagents } from '@/store/session-subagent-folds'
import { $subagentReadOverrides, $subagentSessionRows } from '@/store/subagent-session-cache'
import { clearSubagentUnreadOnOpen } from '@/store/subagent-unread'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import { makeSessionInfo } from '@/test/session-info'

import { SidebarSessionTreeRow } from './session-tree-row'

vi.mock('@/api/sessions', async original => ({
  ...(await original<typeof Sessions>()),
  listSessionSubagents: vi.fn(),
  setSessionUnreadRemote: vi.fn(),
  getSession: vi.fn()
}))

const owner = makeSessionInfo({
  id: 'owner',
  title: 'Owner',
  subagent_count: 1,
  profile: 'work',
  connection_id: 'host'
})

const child = makeSessionInfo({
  id: 'child',
  title: 'Subagent',
  is_internal_child: true,
  _delegate_from: 'owner',
  unread: true,
  profile: 'work',
  connection_id: 'host'
})

const actions = {
  activeSessionId: null,
  onArchiveSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onResumeSession: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleUnread: vi.fn()
}

function Host({ session = owner }) {
  return (
    <SidebarSessionTreeRow
      actions={actions}
      isPinned={false}
      isSelected={false}
      onArchive={() => {}}
      onDelete={() => {}}
      onPin={() => {}}
      onResume={() => {}}
      onToggleUnread={() => {}}
      session={session}
      unread={false}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  $sessions.set([owner])
  $expandedSessionSubagents.set([])
  $subagentReadOverrides.set({})
  $subagentSessionRows.set({})
  $subagentsBySession.set({})
  $liveWorkRoster.set({})
})
afterEach(cleanup)

it('keeps the main row unchanged without subagents, and adds no attention ink for quiet subagents', () => {
  const { container, rerender } = render(<Host session={{ ...owner, subagent_count: 0 }} />)
  expect(container.querySelector('[data-subagent-count]')).toBeNull()
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
  rerender(<Host />)
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
  expect(listSessionSubagents).not.toHaveBeenCalled()
})

it('rolls nested live waiting through lineage aliases and clears promptly on a transition', () => {
  const session = { ...owner, id: 'tip', _lineage_ids: ['owner'] }
  upsertSubagent('owner', { subagent_id: 'nested', parent_id: 'outer', attention: 'waiting' })
  const { container } = render(<Host session={session} />)
  const control = container.querySelector('[data-subagent-count]')!
  expect(control.getAttribute('data-subagent-attention')).toBe('waiting')
  expect(control.getAttribute('aria-label')).toContain('1 · Waiting on you')
  expect(control.querySelector('.bg-amber-500')).toBeTruthy()
  act(() => upsertSubagent('owner', { subagent_id: 'nested', attention: null }))
  expect(container.querySelector('[data-subagent-count]')?.hasAttribute('data-subagent-attention')).toBe(false)
})

it('uses roster attention after reload, and a newer event clear outranks its stale read', () => {
  setLiveWorkRosterSource('host', [{ session_id: 'owner', attention: { stuck: 2 } }], 1, ['owner'])
  const { container } = render(<Host />)
  expect(container.querySelector('[data-subagent-count]')?.getAttribute('data-subagent-attention')).toBe('stuck')
  act(() => upsertSubagent('owner', { subagent_id: 'nested', attention: null }))
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
})

it('clears persisted subagent unread and the fold once its opened page mounts, outside the top-level list', async () => {
  const parent = { ...owner, subagent_attention: { unread: 1, over_budget: 1 } }
  const limited = { ...child, end_reason: 'subagent_max_iterations' }
  $sessions.set([parent])
  vi.mocked(listSessionSubagents).mockResolvedValue({
    sessions: [limited],
    total: 1,
    limit: 50,
    offset: 0,
    has_more: false
  })
  let finish!: (value: { ok: boolean }) => void
  vi.mocked(setSessionUnreadRemote).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  vi.mocked(getSession).mockResolvedValue(owner)
  const { container } = render(<Host session={parent} />)
  expect(container.querySelector('[data-subagent-count]')?.getAttribute('data-subagent-attention')).toBe('over_budget')
  fireEvent.click(container.querySelector('[data-subagent-count]')!)
  await screen.findByText('Subagent')
  expect(container.querySelector('[data-session-id="child"] [class*="ui-success"]')).toBeTruthy()
  fireEvent.click(screen.getByText('Subagent'))
  // The click itself never PATCHes: the backend refuses it until the child's page mounts.
  expect(setSessionUnreadRemote).not.toHaveBeenCalled()
  // The mounted subagent page (use-subagent-subject) marks it read.
  let read!: Promise<boolean>
  act(() => {
    read = clearSubagentUnreadOnOpen('child', 'owner')
  })
  expect(setSessionUnreadRemote).toHaveBeenCalledWith('child', false, 'work', 'host')
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
  expect(container.querySelector('[data-session-id="child"] [class*="ui-success"]')).toBeNull()
  expect($sessions.get()).toHaveLength(1)
  await act(async () => finish({ ok: true }))
  await expect(read).resolves.toBe(true)
  await waitFor(() => expect(getSession).toHaveBeenCalledWith('owner', { profile: 'work', connectionId: 'host' }))
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
})
