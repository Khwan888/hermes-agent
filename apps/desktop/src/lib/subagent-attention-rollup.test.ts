import { expect, it } from 'vitest'

import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import { makeSessionInfo } from '@/test/session-info'

import { sessionSubagentAttention } from './subagent-attention-rollup'

it('includes a grandchild but excludes its own parent subagent and unrelated roots', () => {
  $subagentsBySession.set({})
  upsertSubagent('root', { subagent_id: 'outer', child_session_id: 'middle', attention: 'waiting' })
  upsertSubagent('root', { subagent_id: 'inner', parent_id: 'outer', attention: 'stuck' })
  upsertSubagent('unrelated', { subagent_id: 'other', attention: 'waiting' })
  const counts = sessionSubagentAttention(makeSessionInfo({ id: 'middle' }), $subagentsBySession.get(), {})
  expect(counts.waiting).toBe(0)
  expect(counts.stuck).toBe(1)
})

it('never counts a placeholder row with no stored session as unread: nothing could ever open and clear it', () => {
  $subagentsBySession.set({})
  upsertSubagent('root', { subagent_id: 'delegate-tool:call:0', status: 'completed' }, true, 'subagent.complete')
  upsertSubagent(
    'root',
    { subagent_id: 'real', child_session_id: 'kid', status: 'completed' },
    true,
    'subagent.complete'
  )
  const counts = sessionSubagentAttention(makeSessionInfo({ id: 'root' }), $subagentsBySession.get(), {})
  expect(counts.unread).toBe(1)
})
