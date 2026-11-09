import { beforeEach, expect, it } from 'vitest'

import { $subagentsBySession, reconcileSubagentSnapshot, upsertSubagent } from './subagents'

beforeEach(() => $subagentsBySession.set({}))

const event = (payload: Record<string, unknown>, type = 'subagent.progress') => {
  upsertSubagent('owner', { subagent_id: 'child', ...payload }, true, type)

  return $subagentsBySession.get().owner[0]
}

it('keeps waiting through progress, clears explicit null, and adds no empty stream entry', () => {
  expect(event({ attention: 'waiting', attention_reason: 'approval', attention_since: 123 })).toMatchObject({
    attention: 'waiting',
    attentionReason: 'approval',
    attentionSince: 123,
    stream: []
  })
  expect(event({ text: 'still waiting' }).attention).toBe('waiting')
  expect(event({ attention: null }).attention).toBeUndefined()
})

it('clears stuck on the next own event and clears every live flag at terminal', () => {
  event({ attention: 'stuck' })
  expect(event({ tool_name: 'terminal' }, 'subagent.tool').attention).toBeUndefined()
  event({ attention: 'waiting', attention_reason: 'sudo' })
  expect(event({ status: 'completed', exit_reason: 'max_iterations' }, 'subagent.complete')).toMatchObject({
    attention: undefined,
    attentionReason: undefined,
    attentionSince: undefined,
    exitReason: 'max_iterations',
    unread: true
  })
})

it('restores snapshot attention and recognizes raw timeout without exit_reason', () => {
  reconcileSubagentSnapshot('owner', [
    { subagent_id: 'child', status: 'running', attention: 'stuck', attention_since: 12 }
  ])
  expect($subagentsBySession.get().owner[0]).toMatchObject({ attention: 'stuck', attentionSince: 12 })
  expect(event({ status: 'timeout' }, 'subagent.complete')).toMatchObject({
    exitReason: 'timeout',
    attention: undefined
  })
})

it('does not mark deliberately interrupted subagents unread', () => {
  expect(event({ status: 'interrupted', exit_reason: 'interrupted' }, 'subagent.complete').unread).not.toBe(true)
})
