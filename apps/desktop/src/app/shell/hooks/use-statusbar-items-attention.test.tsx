import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { $liveWorkRoster } from '@/store/live-work-roster'
import { $statusbarHiddenIds, resetStatusbarLayout } from '@/store/statusbar-prefs'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'

import { StatusbarControls } from '../statusbar-controls'

import { useStatusbarItems } from './use-statusbar-items'

function Host() {
  const { leftStatusbarItems } = useStatusbarItems({
    agentsOpen: false,
    changeSessionCwd: async () => {},
    chatOpen: true,
    commandCenterOpen: false,
    extraLeftItems: [],
    extraRightItems: [],
    freshDraftReady: false,
    gatewayState: 'ready',
    inferenceStatus: null,
    openAgents: () => {},
    openCommandCenterSection: () => {},
    requestGateway: async () => undefined as never,
    statusSnapshot: null,
    toggleCommandCenter: () => {}
  })

  return <StatusbarControls leftItems={leftStatusbarItems.filter(item => item.id === 'agents')} />
}

beforeEach(() => {
  resetStatusbarLayout()
  $subagentsBySession.set({})
  $liveWorkRoster.set({})
})
afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
  $liveWorkRoster.set({})
})
it('does not change the hidden-by-default Agents item without human attention', () => {
  expect($statusbarHiddenIds.get()).toContain('agents')

  const { container } = render(
    <MemoryRouter>
      <Host />
    </MemoryRouter>
  )

  expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull()
  expect(container.querySelector('[data-subagent-attention]')).toBeNull()
})
it.each(['waiting', 'stuck'] as const)(
  'unhides only while a nested subagent is %s and preserves the preference',
  attention => {
    const { container } = render(
      <MemoryRouter>
        <Host />
      </MemoryRouter>
    )

    act(() => {
      upsertSubagent('background', { subagent_id: 'outer', status: 'running' })
      upsertSubagent('background', { subagent_id: 'nested', parent_id: 'outer', attention })
    })
    expect(screen.getByRole('button', { name: /Agents\s*1 need you/ })).toBeTruthy()
    expect(container.querySelector('[data-subagent-attention]')?.getAttribute('data-subagent-attention')).toBe(attention)
    expect($statusbarHiddenIds.get()).toContain('agents')
    act(() => upsertSubagent('background', { subagent_id: 'nested', attention: null }))
    expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull()
  }
)
it('counts waits and stuck subagents together without un-hiding for other terminal history', () => {
  upsertSubagent('one', { subagent_id: 'waiting', attention: 'waiting' })
  upsertSubagent('two', { subagent_id: 'stuck', attention: 'stuck' })

  const { container } = render(
    <MemoryRouter>
      <Host />
    </MemoryRouter>
  )

  expect(screen.getByText('2 need you')).toBeTruthy()
  expect(container.querySelector('[data-subagent-attention]')?.getAttribute('data-subagent-attention')).toBe('waiting')
})

it('does not unhide for unread or over-budget completions', () => {
  upsertSubagent(
    'owner',
    { subagent_id: 'limited', status: 'completed', exit_reason: 'max_iterations' },
    true,
    'subagent.complete'
  )
  render(
    <MemoryRouter>
      <Host />
    </MemoryRouter>
  )
  expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull()
})
