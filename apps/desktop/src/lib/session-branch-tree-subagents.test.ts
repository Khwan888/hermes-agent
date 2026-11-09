import { describe, expect, it } from 'vitest'

import { makeSessionInfo } from '@/test/session-info'

import { flattenSessionsWithBranches } from './session-branch-tree'

const row = (id: string, extra = {}) => makeSessionInfo({ id, ...extra })

describe('sidebar owner identity and subagent isolation', () => {
  it('keeps same-id parents and forks on different profiles and connections', () => {
    const sessions = ['home', 'work'].flatMap(profile =>
      ['local', 'remote'].flatMap(connection_id => [
        row('parent', { profile, connection_id }),
        row('fork', { profile, connection_id, _branched_from: 'parent' })
      ])
    )

    expect(
      flattenSessionsWithBranches(sessions, { preserveOrder: true }).map(e => [
        e.session.profile,
        e.session.connection_id,
        e.session.id,
        e.branchStem
      ])
    ).toEqual([
      ['home', 'local', 'parent', undefined],
      ['home', 'local', 'fork', '└─ '],
      ['home', 'remote', 'parent', undefined],
      ['home', 'remote', 'fork', '└─ '],
      ['work', 'local', 'parent', undefined],
      ['work', 'local', 'fork', '└─ '],
      ['work', 'remote', 'parent', undefined],
      ['work', 'remote', 'fork', '└─ ']
    ])
  })

  it('never promotes opened subagents or their branches into normal listing roots', () => {
    const parent = row('parent')
    const subagent = row('subagent', { source: 'subagent', parent_session_id: 'parent' })
    const opened = row('opened', { is_internal_child: true, parent_session_id: 'missing' })
    const fork = row('fork', { _branched_from: 'subagent' })
    expect(flattenSessionsWithBranches([subagent, opened, fork, parent])).toEqual([{ session: parent }])
    expect(flattenSessionsWithBranches([subagent])).toEqual([])
    expect(flattenSessionsWithBranches([subagent, opened], { includeSubagents: true }).map(e => e.session.id)).toEqual([
      'subagent',
      'opened'
    ])
  })

  it('keeps subagent compression aliases behind the fold and nests ordinary forks under the surviving tip', () => {
    const subagent = row('subagent-tip', { is_internal_child: true, _lineage_root_id: 'subagent-root', _lineage_ids: ['subagent-root', 'subagent-mid', 'subagent-tip'] })
    const branch = row('branch', { _branched_from: 'subagent-mid' })
    expect(flattenSessionsWithBranches([subagent, branch])).toEqual([])
    const parent = row('tip', { _lineage_root_id: 'root', _lineage_ids: ['root', 'mid', 'tip'] })
    const ordinary = row('fork', { _branched_from: 'mid' })
    expect(flattenSessionsWithBranches([parent, ordinary])).toEqual([
      { session: parent }, { session: ordinary, branchStem: '└─ ' }
    ])
  })

  it('does not mistake explicit non-subagent resets and branches for delegate children', () => {
    const reset = row('reset', { source: 'subagent', _reset_from: 'subagent', parent_session_id: 'subagent' })
    const ordinary = row('ordinary', { source: 'subagent', is_internal_child: false })
    expect(flattenSessionsWithBranches([reset, ordinary], { preserveOrder: true })).toEqual([
      { session: reset }, { session: ordinary }
    ])
  })

  it('renders actual depth for a branch of a branch', () => {
    const parent = row('parent')
    const child = row('child', { _branched_from: 'parent' })
    const grandchild = row('grandchild', { _branched_from: 'child' })
    expect(flattenSessionsWithBranches([parent, child, grandchild]).map(e => e.branchStem)).toEqual([
      undefined,
      '└─ ',
      '   └─ '
    ])
  })
})
