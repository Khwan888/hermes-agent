import { afterEach, expect, it, vi } from 'vitest'

import { makeSessionInfo } from '@/test/session-info'

import type * as Client from './client'
import { hermesApi, setApiRequestConnection, setSessionOwnerResolver } from './client'
import { listSessionSubagents } from './sessions'

vi.mock('./client', async original => ({
  ...(await original<typeof Client>()),
  hermesApi: vi.fn()
}))

afterEach(() => {
  vi.clearAllMocks()
  setSessionOwnerResolver(null)
  setApiRequestConnection(null)
})

it('pins subagent reads to the parent owner, encodes ids and bounds pages without changing parent lists', async () => {
  setApiRequestConnection('wrong-ambient')
  setSessionOwnerResolver(() => ({ connectionId: 'owner-host', profile: 'research' }))
  vi.mocked(hermesApi).mockResolvedValue({
    sessions: [makeSessionInfo({ id: 'child' })],
    total: 101,
    limit: 100,
    offset: 0,
    has_more: true
  })
  const page = await listSessionSubagents('parent/id', undefined, { limit: 999, offset: -5 })
  expect(hermesApi).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: 'owner-host',
      profile: 'research',
      path: '/api/sessions/parent%2Fid/subagents?profile=research&limit=100&offset=0'
    })
  )
  expect(page.sessions[0]).toMatchObject({ connection_id: 'owner-host', profile: 'research', is_internal_child: true })
  expect(page).toMatchObject({ total: 101, has_more: true })
})

it('honors explicit local pins and retains that captured owner after the ambient connection changes', async () => {
  let resolve!: (page: unknown) => void
  vi.mocked(hermesApi).mockReturnValue(
    new Promise(done => {
      resolve = done
    })
  )
  const pending = listSessionSubagents('p', { connectionId: 'local', profile: 'work' }, { offset: 50 })
  setApiRequestConnection('elsewhere')
  resolve({ sessions: [makeSessionInfo({ id: 'c' })], total: 51, limit: 50, offset: 50, has_more: false })
  expect((await pending).sessions[0]).toMatchObject({ connection_id: 'local', profile: 'work' })
  expect(hermesApi).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: 'local',
      profile: 'work',
      path: '/api/sessions/p/subagents?profile=work&limit=50&offset=50'
    })
  )
})
