import { afterEach, expect, it, vi } from 'vitest'

import { sessionTreeKey } from '@/lib/session-branch-tree'
import { makeSessionInfo } from '@/test/session-info'

import { dropTilesForProfile, migrateTilesForProfile } from './session-states'

const folds = await import('./session-subagent-folds')
afterEach(() => folds.$expandedSessionSubagents.set([]))

const key = (connection_id: string, profile: string, id = 's') =>
  sessionTreeKey(makeSessionInfo({ id, connection_id, profile }))

it('persists expanded folds across a fresh module load and keeps lineage/owner identity', async () => {
  const root = makeSessionInfo({ id: 'tip', connection_id: 'local', profile: 'work', _lineage_root_id: 'root' })
  folds.setSessionSubagentsExpanded(sessionTreeKey(root, root._lineage_root_id!), true)
  vi.resetModules()
  const reloaded = await import('./session-subagent-folds')
  expect(reloaded.$expandedSessionSubagents.get()).toEqual(['["local","work","root"]'])
  expect(reloaded.$expandedSessionSubagents.get()).not.toContain(key('host', 'work', 'root'))
  expect(reloaded.$expandedSessionSubagents.get()).not.toContain(key('local', 'other', 'root'))
  reloaded.setSessionSubagentsExpanded('["local","work","root"]', false)
  vi.resetModules()
  expect((await import('./session-subagent-folds')).$expandedSessionSubagents.get()).toEqual([])
})

it('moves local folds on profile rename, leaves remote twins alone and drops only the deleted owner', () => {
  folds.$expandedSessionSubagents.set([key('local', 'before'), key('host', 'before'), key('other-host', 'before')])
  migrateTilesForProfile('before', 'after')
  expect(folds.$expandedSessionSubagents.get()).toEqual([
    key('local', 'after'),
    key('host', 'before'),
    key('other-host', 'before')
  ])
  dropTilesForProfile('after')
  expect(folds.$expandedSessionSubagents.get()).toEqual([key('host', 'before'), key('other-host', 'before')])
  dropTilesForProfile('alias', { connectionId: 'host', profile: 'alias', targetProfile: 'before' })
  expect(folds.$expandedSessionSubagents.get()).toEqual([key('other-host', 'before')])
})

it('a remote profile delete keeps the same-named local profile folds, and a local delete keeps the remote ones', () => {
  folds.$expandedSessionSubagents.set([key('local', 'work', 'a'), key('host', 'work', 'b'), key('local', 'other', 'c')])
  dropTilesForProfile('work', { connectionId: 'host', profile: 'work' })
  expect(folds.$expandedSessionSubagents.get()).toEqual([key('local', 'work', 'a'), key('local', 'other', 'c')])
  folds.$expandedSessionSubagents.set([key('local', 'work', 'a'), key('host', 'work', 'b')])
  dropTilesForProfile('work', { connectionId: 'local', profile: 'work' })
  expect(folds.$expandedSessionSubagents.get()).toEqual([key('host', 'work', 'b')])
})

it('a rename moves only the renamed profile and never collapses a fold into a duplicate', () => {
  folds.$expandedSessionSubagents.set([key('local', 'old', 'a'), key('local', 'new', 'a'), key('local', 'keep', 'b')])
  migrateTilesForProfile('old', 'new')
  expect(folds.$expandedSessionSubagents.get()).toEqual([key('local', 'new', 'a'), key('local', 'keep', 'b')])
})
