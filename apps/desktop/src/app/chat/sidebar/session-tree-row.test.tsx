import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listSessionSubagents } from '@/api/sessions'
import type * as Sessions from '@/api/sessions'
import { $expandedSessionSubagents } from '@/store/session-subagent-folds'
import { makeSessionInfo } from '@/test/session-info'

import { type SessionTreeActions, SidebarSessionTreeRow } from './session-tree-row'

vi.mock('@/api/sessions', async original => ({
  ...(await original<typeof Sessions>()),
  listSessionSubagents: vi.fn()
}))
// Keep the real row and controls; only network requests are substituted.
const parent = makeSessionInfo({ id: 'alpha', title: 'Alpha', subagent_count: 2, profile: 'work', connection_id: 'host' })

const beta = makeSessionInfo({
  id: 'beta',
  title: 'Beta',
  subagent_count: 1,
  parent_session_id: 'alpha',
  is_internal_child: true,
  profile: 'work',
  connection_id: 'host'
})

const gamma = makeSessionInfo({
  id: 'gamma',
  title: 'Gamma',
  parent_session_id: 'beta',
  is_internal_child: true,
  profile: 'work',
  connection_id: 'host'
})

const page = (sessions = [beta], has_more = false, offset = 0) => ({
  sessions,
  total: has_more ? 2 : sessions.length + offset,
  limit: 50,
  offset,
  has_more
})

const actions: SessionTreeActions = {
  activeSessionId: null,
  onArchiveSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onResumeSession: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleUnread: vi.fn()
}

function Host({ session = parent }) {
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
  $expandedSessionSubagents.set([])
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('folded sidebar subagents', () => {
  it('is lean without subagents and does not fetch while collapsed', () => {
    const { rerender, container } = render(<Host session={{ ...parent, subagent_count: 0 }} />)
    expect(container.querySelector('[data-subagent-count]')).toBeNull()
    rerender(<Host />)
    expect(screen.getByRole('button', { name: '2 subagents' }).getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(1)
    expect(listSessionSubagents).not.toHaveBeenCalled()
  })

  it('opens nested subagents at real depth without navigating and restores folds after remount', async () => {
    vi.mocked(listSessionSubagents).mockImplementation(async id => page(id === 'alpha' ? [beta] : [gamma]))
    const { container, unmount } = render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    fireEvent.click(await screen.findByRole('button', { name: '1 subagent' }))
    await screen.findByText('Gamma')
    expect(container.querySelector('[data-session-id="beta"]')?.getAttribute('data-subagent-depth')).toBe('1')
    expect(container.querySelector('[data-session-id="gamma"]')?.getAttribute('data-subagent-depth')).toBe('2')
    expect(container.querySelector('[data-session-id="gamma"]')?.getAttribute('data-parent-session-id')).toBe('beta')
    expect(actions.onResumeSession).not.toHaveBeenCalled()
    unmount()
    render(<Host />)
    await screen.findByText('Gamma')
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    expect(screen.queryByText('Beta')).toBeNull()
    expect(screen.queryByText('Gamma')).toBeNull()
  })

  it('pages only on request and retries the failed page without losing loaded children', async () => {
    vi.mocked(listSessionSubagents)
      .mockResolvedValueOnce(page([beta], true))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([makeSessionInfo({ id: 'delta', title: 'Delta' })], false, 1))
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show more subagents' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await screen.findByText('Delta')
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(listSessionSubagents).toHaveBeenNthCalledWith(
      3,
      'alpha',
      { connectionId: 'host', profile: 'work' },
      { limit: 50, offset: 1 }
    )
  })

  it('offers initial error recovery and ignores replies from an owner left behind', async () => {
    let resolve!: (result: ReturnType<typeof page>) => void
    vi.mocked(listSessionSubagents)
      .mockReturnValueOnce(
        new Promise(done => {
          resolve = done
        })
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page())
    const { rerender } = render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    rerender(<Host session={{ ...parent, connection_id: 'other' }} />)
    await act(async () => resolve(page()))
    expect(screen.queryByText('Beta')).toBeNull()
    expect(screen.getByRole('button', { name: '2 subagents' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy())
  })

  it('re-reads an already open subtree when a new child appears, keeping loaded rows and fetching nothing while folded', async () => {
    const delta = makeSessionInfo({
      id: 'delta',
      title: 'Delta',
      parent_session_id: 'alpha',
      is_internal_child: true,
      profile: 'work',
      connection_id: 'host'
    })

    vi.mocked(listSessionSubagents).mockResolvedValueOnce(page([beta], true)).mockResolvedValueOnce(page([gamma], false, 1))
    const { container, rerender } = render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: /2 subagents/ }))
    await screen.findByText('Beta')
    fireEvent.click(await screen.findByRole('button', { name: /more/i }))
    await screen.findByText('Gamma')

    // A sidebar refresh reports a third child while the fold is open.
    vi.mocked(listSessionSubagents).mockResolvedValueOnce({ ...page([delta, beta], true), total: 3 })
    rerender(<Host session={{ ...parent, subagent_count: 3 }} />)
    await screen.findByText('Delta')
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('Gamma')).toBeTruthy()
    expect(vi.mocked(listSessionSubagents).mock.calls.at(-1)?.[2]).toEqual({ limit: 50, offset: 0 })

    const titles = [...container.querySelectorAll('[data-subagent-children="alpha"] [data-session-id]')].map(el =>
      el.getAttribute('data-session-id')
    )

    expect(titles).toEqual(['delta', 'beta', 'gamma'])

    // Folded: a count change fetches nothing.
    fireEvent.click(screen.getByRole('button', { name: /3 subagents/ }))
    const calls = vi.mocked(listSessionSubagents).mock.calls.length
    rerender(<Host session={{ ...parent, subagent_count: 4 }} />)
    await act(async () => undefined)
    expect(vi.mocked(listSessionSubagents).mock.calls.length).toBe(calls)
  })
})
