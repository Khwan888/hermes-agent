import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { listSessionSubagents } from '@/api/sessions'
import type * as Sessions from '@/api/sessions'
import { makeSessionInfo } from '@/test/session-info'

import { SidebarSessionsSection } from './sessions-section'

vi.mock('@/api/sessions', async original => ({
  ...(await original<typeof Sessions>()),
  listSessionSubagents: vi.fn()
}))

afterEach(cleanup)

it('shows a collapsed subagent count on the existing parent row without loading children', () => {
  const noop = () => {}

  const { container } = render(<SidebarSessionsSection activeSessionId={null} emptyState={null} label="Sessions" onArchiveSession={noop}
    onDeleteSession={noop}
    onResumeSession={noop} onToggle={noop} onTogglePin={noop} onToggleUnread={noop}
    open pinned={false} sessions={[makeSessionInfo({ id: 'count-only', title: 'Count only', subagent_count: 3 })]} />)

  const fold = screen.getByRole('button', { name: '3 subagents' })
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(fold.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe('count-only')
  expect(container.querySelectorAll('[data-session-id]')).toHaveLength(1)
})

it('keeps normal root rows and their order unchanged until a subagent fold is expanded', async () => {
  const alpha = makeSessionInfo({ id: 'alpha', title: 'Alpha', subagent_count: 2 })
  const unrelated = makeSessionInfo({ id: 'unrelated', title: 'Unrelated', subagent_count: 0 })

  const opened = makeSessionInfo({
    id: 'opened',
    title: 'Opened subagent',
    is_internal_child: true,
    parent_session_id: 'alpha'
  })

  const beta = makeSessionInfo({
    id: 'beta',
    title: 'Beta',
    subagent_count: 0,
    is_internal_child: true,
    parent_session_id: 'alpha'
  })

  vi.mocked(listSessionSubagents).mockResolvedValue({ sessions: [beta], total: 1, limit: 50, offset: 0, has_more: false })

  const noop = () => {}
  render(
    <SidebarSessionsSection
      activeSessionId={null}
      emptyState={null}
      label="Sessions"
      onArchiveSession={noop}
      onDeleteSession={noop}
      onResumeSession={noop}
      onToggle={noop}
      onTogglePin={noop}
      onToggleUnread={noop}
      open
      pinned={false}
      preserveOrder
      sessions={[alpha, unrelated, opened]}
    />
  )
  expect(screen.queryByText('Opened subagent')).toBeNull()
  expect(screen.getByText('Alpha')).toBeTruthy()
  expect(screen.getByText('Unrelated')).toBeTruthy()
  expect(listSessionSubagents).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '2 subagents' }))
  await screen.findByText('Beta')
  expect(screen.queryByText('Opened subagent')).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '2 subagents' })))
  expect(screen.queryByText('Beta')).toBeNull()
})
