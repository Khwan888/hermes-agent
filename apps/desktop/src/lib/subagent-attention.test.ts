import { expect, it } from 'vitest'

import {
  countSubagentAttention,
  resolveSubagentAttention,
  rollupSubagentAttention,
  subagentAttention
} from './subagent-attention'

it.each([
  [{ attention: 'waiting', exitReason: 'timeout', unread: true }, 'waiting'],
  [{ attention: 'stuck', unread: true }, 'stuck'],
  [{ exitReason: 'max_iterations', unread: true }, 'over_budget'],
  [{ end_reason: 'subagent_timeout', unread: true }, 'unread'],
  [{ exitReason: 'timeout', unread: false }, undefined],
  [{ unread: true }, 'unread'],
  [{}, undefined]
] as const)('resolves %j as %s', (input, expected) => expect(subagentAttention(input)).toBe(expected))

it('rolls up every depth without counting overlapping sources twice', () => {
  const live = countSubagentAttention([{ attention: 'waiting' }, { attention: 'stuck' }, { unread: true }])
  const counts = rollupSubagentAttention(live, { waiting: 1, stuck: 2 }, { unread: 4, over_budget: 1 })
  expect(counts).toEqual({ waiting: 1, stuck: 2, unread: 4, over_budget: 1 })
  expect(resolveSubagentAttention(counts)).toEqual({ state: 'waiting', count: 1 })
  expect(resolveSubagentAttention({})).toBeUndefined()
})
