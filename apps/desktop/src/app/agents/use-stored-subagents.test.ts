import { expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { mergeStoredSubagents } from './use-stored-subagents'

const child = (extra: Partial<SessionInfo>): SessionInfo => ({
  id: 'child', preview: 'subagent', title: null, source: 'subagent', ended_at: 200, started_at: 100,
  last_active: 200, is_active: false, input_tokens: 0, output_tokens: 0, message_count: 1,
  tool_call_count: 0, model: 'launch-model', ...extra
})

const recover = (session: SessionInfo) => mergeStoredSubagents([], [{ parentId: 'parent', session }])[0]

it('keeps a deliberately interrupted child interrupted after reload', () => {
  const row = recover(child({ subagent_observation: { status: 'interrupted', route: null, duration_seconds: 4 } }))
  expect(row.status).toBe('interrupted')
  expect(row.durationSeconds).toBe(4)
})

it('shows the observed route, including a fallback, instead of the launch model', () => {
  const row = recover(
    child({
      subagent_observation: {
        status: 'completed',
        duration_seconds: 9,
        route: { provider: 'backup', model: 'fallback-model', effective_effort: 'low', fallback_activated: true }
      }
    })
  )

  expect(row.model).toBe('fallback-model')
  expect(row.route).toMatchObject({ provider: 'backup', fallback_activated: true, effective_effort: 'low', effort_source: 'unknown' })
})

it('guesses neither route nor effort without an observation', () => {
  const row = recover(child({ subagent_observation: null }))
  expect(row.route).toBeUndefined()
  expect(row.model).toBe('launch-model')
  expect(row.status).toBe('completed')
})

it('keeps budget endings and open rows truthful', () => {
  expect(recover(child({ end_reason: 'subagent_timeout' }))).toMatchObject({ status: 'failed' })
  expect(recover(child({ ended_at: null, subagent_observation: { status: 'completed', route: null, duration_seconds: null } })).status).toBe('running')
  expect(recover(child({ subagent_observation: { status: 'running', route: null, duration_seconds: null } })).status).toBe('completed')
})
