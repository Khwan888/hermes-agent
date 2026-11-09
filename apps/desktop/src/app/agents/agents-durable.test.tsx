import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { listSessionSubagents } from '@/api/sessions'
import { I18nProvider } from '@/i18n/context'
import { $activeSessionId, $selectedStoredSessionId, $sessions, _resetSessionOwnerHintsForTests } from '@/store/session'
import { knownOwnerForSession } from '@/store/session-states'
import { $finishedSubagentsBySession, $subagentsBySession, upsertSubagent } from '@/store/subagents'
import type { SessionInfo } from '@/types/hermes'

import { AgentsView } from '.'

const { opened, missing } = vi.hoisted(() => ({ opened: [] as string[], missing: new Set<string>() }))
vi.mock('@/api/sessions', () => ({
  listSessionSubagents: vi.fn(),
  markSubagentListingRouteMissing: (key: string) => missing.add(key),
  subagentListingRouteMissing: (key: string) => missing.has(key)
}))
vi.mock('@/app/open-subagent', () => ({ openSubagent: (subagent: { sessionId: string }) => opened.push(subagent.sessionId) }))

const session = (id: string, preview: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, preview, title: null, source: 'subagent', ended_at: 200, started_at: 100,
  last_active: 200, is_active: false, input_tokens: 0, output_tokens: 0,
  message_count: 1, tool_call_count: 0, model: null, ...extra
})

const page = (sessions: SessionInfo[], offset = 0, has_more = false) => ({
  sessions, total: sessions.length, limit: 50, offset, has_more
})

beforeAll(() => {
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as never
})
afterEach(() => {
  cleanup()
  $sessions.set([])
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  _resetSessionOwnerHintsForTests()
  $subagentsBySession.set({})
  $finishedSubagentsBySession.set({})
  opened.length = 0
  missing.clear()
  vi.resetAllMocks()
})

describe('Agents durable history', () => {
  it('recovers this owner’s paged children and nested subagents after a renderer restart, without duplicating live rows', async () => {
    $activeSessionId.set('parent')
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'remote' })])
    vi.mocked(listSessionSubagents).mockImplementation(async (id, _scope, options) => {
      if (id === 'parent' && options?.offset === 0) {return page([session('alpha', 'subagent alpha')], 0, true)}

      if (id === 'parent') {return page([session('beta', 'subagent beta', { subagent_count: 1 })], 1)}

      if (id === 'beta') {return page([session('gamma', 'subagent gamma')])}
      throw new Error(`unexpected session ${id}`)
    })

    const onClose = vi.fn()
    const { container, getByText } = render(<I18nProvider configClient={null} initialLocale="en"><AgentsView onClose={onClose} /></I18nProvider>)
    await waitFor(() => expect(getByText('subagent gamma')).toBeTruthy())
    expect(getByText('subagent alpha')).toBeTruthy()
    expect(getByText('subagent beta')).toBeTruthy()
    act(() => upsertSubagent('parent', { subagent_id: 'live-alpha', child_session_id: 'alpha', goal: 'subagent alpha', status: 'completed' }))
    expect(container.querySelectorAll('[data-session-id="alpha"]')).toHaveLength(1)
    expect(container.querySelector('[data-session-id="gamma"]')?.getAttribute('data-parent-session-id')).toBe('beta')
    expect(vi.mocked(listSessionSubagents).mock.calls.map(([id, scope]) => [id, scope])).toEqual([
      ['parent', { connectionId: 'remote', profile: 'work' }],
      ['parent', { connectionId: 'remote', profile: 'work' }],
      ['beta', { connectionId: 'remote', profile: 'work' }]
    ])
    fireEvent.click(container.querySelector('[data-session-id="gamma"] [data-subagent-open]')!)
    expect(opened).toEqual(['gamma'])
    expect(knownOwnerForSession('gamma')).toMatchObject({ connectionId: 'remote', profile: 'work' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not paint a late response from a previous session', async () => {
    $sessions.set([
      session('old', 'old', { profile: 'one', connection_id: 'remote' }),
      session('new', 'new', { profile: 'two', connection_id: 'remote' })
    ])
    $activeSessionId.set('old')
    let resolveOld!: (value: ReturnType<typeof page>) => void
    vi.mocked(listSessionSubagents).mockImplementation(id => id === 'old'
      ? new Promise(resolve => { resolveOld = resolve })
      : Promise.resolve(page([session('new-child', 'new subagent')])))
    const { queryByText } = render(<I18nProvider configClient={null} initialLocale="en"><AgentsView onClose={vi.fn()} /></I18nProvider>)
    await waitFor(() => expect(resolveOld).toBeDefined())
    act(() => $activeSessionId.set('new'))
    await waitFor(() => expect(queryByText('new subagent')).toBeTruthy())
    await act(async () => resolveOld(page([session('old-child', 'old private subagent')])))
    expect(queryByText('old private subagent')).toBeNull()
    expect(queryByText('new subagent')).toBeTruthy()
  })

  const renderAgents = () =>
    render(<I18nProvider configClient={null} initialLocale="en"><AgentsView onClose={vi.fn()} /></I18nProvider>)

  it('tells loading, a failed history read and an empty chat apart, and retries a failed read', async () => {
    $activeSessionId.set('parent')
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'remote' })])
    let fail!: (error: Error) => void
    vi.mocked(listSessionSubagents).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const view = renderAgents()
    expect(view.getByText('Loading this chat’s subagents…')).toBeTruthy()
    expect(view.queryByText(/^No (live )?subagents/)).toBeNull()

    await act(async () => fail(new Error('Error invoking remote method \'hermes:api\': Error: 401: unauthorized')))
    expect(view.getByText('Couldn’t load earlier subagents.')).toBeTruthy()
    expect(view.queryByText(/^No (live )?subagents/)).toBeNull()

    vi.mocked(listSessionSubagents).mockResolvedValueOnce(page([session('alpha', 'subagent alpha')]))
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(view.getByText('subagent alpha')).toBeTruthy())
    expect(view.queryByText('Couldn’t load earlier subagents.')).toBeNull()
  })

  it('shows a truly empty chat as empty, and an older backend without the history route as live-only without re-probing', async () => {
    $activeSessionId.set('parent')
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'old-remote' })])
    vi.mocked(listSessionSubagents).mockRejectedValue(new Error('404: {"detail":"No such API endpoint: /api/sessions/parent/subagents"}'))
    const first = renderAgents()
    await waitFor(() => expect(first.getByText(/^No (live )?subagents/)).toBeTruthy())
    expect(first.queryByRole('button', { name: 'Retry' })).toBeNull()
    first.unmount()

    renderAgents()
    expect(listSessionSubagents).toHaveBeenCalledTimes(1)

    cleanup()
    vi.mocked(listSessionSubagents).mockReset()
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'new-remote' })])
    vi.mocked(listSessionSubagents).mockResolvedValue(page([]))
    const empty = renderAgents()
    await waitFor(() => expect(empty.getByText(/^No (live )?subagents/)).toBeTruthy())
    expect(listSessionSubagents).toHaveBeenCalledTimes(1)
  })

  it('re-reads history in place when a list refresh reports a new child, keeping loaded rows', async () => {
    $activeSessionId.set('parent')
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'remote', subagent_count: 1 })])
    vi.mocked(listSessionSubagents).mockResolvedValueOnce(page([session('alpha', 'subagent alpha')]))
    const view = renderAgents()
    await waitFor(() => expect(view.getByText('subagent alpha')).toBeTruthy())

    let resolve!: (value: ReturnType<typeof page>) => void
    vi.mocked(listSessionSubagents).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    act(() => $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'remote', subagent_count: 2 })]))
    await waitFor(() => expect(listSessionSubagents).toHaveBeenCalledTimes(2))
    // The reload never blanks rows a previous read proved.
    expect(view.getByText('subagent alpha')).toBeTruthy()

    await act(async () => resolve(page([session('beta', 'subagent beta'), session('alpha', 'subagent alpha')])))
    expect(view.getByText('subagent beta')).toBeTruthy()
    expect(view.getByText('subagent alpha')).toBeTruthy()
  })

  it('keeps live subagents on screen when the history read fails', async () => {
    $activeSessionId.set('parent')
    $sessions.set([session('parent', 'parent', { profile: 'work', connection_id: 'remote' })])
    upsertSubagent('parent', { subagent_id: 'live-1', goal: 'live subagent', status: 'running' })
    vi.mocked(listSessionSubagents).mockRejectedValue(new Error('timeout'))
    const view = renderAgents()
    await waitFor(() => expect(view.container.querySelector('[data-subagent-history="failed"]')).toBeTruthy())
    expect(view.getByText('live subagent')).toBeTruthy()
  })
})
