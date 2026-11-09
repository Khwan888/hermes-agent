import { beforeEach, expect, it } from 'vitest'

import { $subagentsBySession, reconcileSubagentSnapshot, upsertSubagent } from './subagents'

const route = {
  provider: 'openrouter',
  model: 'served/model',
  requested_effort: 'high',
  wire_effort: 'medium',
  effective_effort: 'medium',
  effort_source: 'default',
  reasoning_status: 'enabled',
  observed: true,
  fallback_activated: true
}

const row = () => $subagentsBySession.get().owner?.[0]
beforeEach(() => $subagentsBySession.set({}))

it('retains the actual route through events, legacy snapshots and completion model changes', () => {
  upsertSubagent('owner', { subagent_id: 'child', model: 'requested/model', route }, true, 'subagent.start')
  expect(row()).toMatchObject({ model: 'served/model', route, parentSessionId: 'owner' })
  reconcileSubagentSnapshot('owner', [{ subagent_id: 'child', model: 'stale/model' }])
  expect(row()).toMatchObject({ model: 'served/model', route, parentSessionId: 'owner' })
  const finalRoute = { ...route, model: 'fallback/model', effective_effort: 'low' }
  upsertSubagent(
    'owner',
    { subagent_id: 'child', model: 'stale/model', status: 'completed', route: finalRoute },
    false,
    'subagent.complete'
  )
  expect(row()).toMatchObject({ model: 'fallback/model', route: finalRoute, status: 'completed' })
})

it('hydrates routes from snapshots without interpreting unknown nulls as disabled', () => {
  const unknownRoute = {
    ...route,
    provider: null,
    model: null,
    effective_effort: null,
    wire_effort: null,
    requested_effort: null,
    effort_source: 'unknown',
    reasoning_status: 'unknown',
    observed: false,
    fallback_activated: null
  }

  reconcileSubagentSnapshot('owner', [{ subagent_id: 'child', model: 'legacy/model', route: unknownRoute }])
  expect(row()).toMatchObject({ model: 'legacy/model', route: unknownRoute })
})

it('preserves legacy model updates when connected to an older backend', () => {
  upsertSubagent('owner', { subagent_id: 'child', model: 'legacy/start' })
  upsertSubagent(
    'owner',
    { subagent_id: 'child', model: 'legacy/end', status: 'completed' },
    false,
    'subagent.complete'
  )
  expect(row()).toMatchObject({ model: 'legacy/end' })
  expect(row()).not.toHaveProperty('route', expect.anything())
})

it('treats a route without an explicit observation as not yet observed', () => {
  const { observed: _observed, ...noFlag } = route
  upsertSubagent('owner', { subagent_id: 'child', route: noFlag }, true, 'subagent.start')
  expect(row()?.route).toMatchObject({ observed: false, effective_effort: 'medium' })
})
