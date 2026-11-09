import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $subagentsBySession, buildSubagentTree, upsertSubagent } from '@/store/subagents'

import { SubagentRow } from './index'

vi.mock('@/lib/use-enter-animation', () => ({ useEnterAnimation: () => undefined }))
afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
})

it.each([
  [{ attention: 'waiting' }, 'waiting', 'Waiting on you'],
  [{ attention: 'stuck' }, 'stuck', 'No progress'],
  [{ status: 'completed', exit_reason: 'max_iterations', unread: true }, 'over_budget', 'Over budget'],
  [{ status: 'completed', unread: true }, 'unread', 'Unread']
])('marks Agents and shared status-stack rows for %s', (payload, state, label) => {
  upsertSubagent('owner', { subagent_id: 'child', goal: 'Review', ...payload })
  const node = buildSubagentTree($subagentsBySession.get().owner)[0]
  const { container } = render(<SubagentRow node={node} nowMs={Date.now()} />)
  expect(container.querySelector('[data-subagent-id="child"]')?.getAttribute('data-subagent-attention')).toBe(state)
  expect(container.textContent).toContain(label)
})

it('adds neither a flag nor a chip without attention', () => {
  upsertSubagent('owner', { subagent_id: 'child', goal: 'Review' })

  const { container } = render(
    <SubagentRow node={buildSubagentTree($subagentsBySession.get().owner)[0]} nowMs={Date.now()} />
  )

  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
  expect(container.querySelector('[data-slot="badge"]')).toBeNull()
})
