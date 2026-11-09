import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'

import { SubagentSettingsMenuRow } from './subagent-settings'

const preset = {
  backend: 'default',
  model: 'b',
  provider: 'fixture',
  reasoning_effort: 'high',
  max_spawn_depth: 1,
  max_concurrent_children: 1,
  backends: {}
}

afterEach(cleanup)

/** Presets sit one level down, inside the Subagents row, so a long library never floods the model menu. */
async function openSubagents() {
  const trigger = await waitFor(() => {
    const row = screen.getByRole('menuitem', { name: /^Subagents$/ })
    expect(row.getAttribute('aria-haspopup')).toBe('menu')

    return row
  })

  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
}

it('without saved presets, the Subagents row is one plain footer item', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'delegation.presets'
      ? { presets: [], default_preset: null }
      : { defaults: preset, effective: preset, override: null, preset_name: null }
  )

  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SubagentSettingsMenuRow profile="alpha" request={request as never} sessionId="chat-a" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await waitFor(() => expect(request).toHaveBeenCalledWith('delegation.presets', { profile: 'alpha' }))
  const row = await screen.findByRole('menuitem', { name: /^Subagents$/ })
  expect(row.getAttribute('aria-haspopup')).toBeNull()
  expect(screen.queryByText('Subagent presets')).toBeNull()
})

it('nests saved presets inside Subagents and applies one only to this chat', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'delegation.presets'
      ? { presets: [{ name: 'quick-team', settings: preset }], default_preset: null }
      : { defaults: preset, effective: preset, override: preset, preset_name: 'quick-team' }
  )

  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SubagentSettingsMenuRow connectionId="remote" profile="alpha" request={request as never} sessionId="chat-a" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await openSubagents()
  expect(await screen.findByRole('menuitem', { name: 'Edit for this chat…' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: /quick-team/ }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('delegation.settings', {
      profile: 'alpha',
      session_id: 'chat-a',
      preset_name: 'quick-team'
    })
  )
  // Capability read on open, the apply, then the confirming read.
  await waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'delegation.settings')).toHaveLength(3))
})

it('never offers or applies a previous owner\'s presets while the next owner\'s list loads', async () => {
  let resolveBeta: (value: unknown) => void = () => undefined

  const alpha = vi.fn(async (method: string) =>
    method === 'delegation.presets'
      ? { presets: [{ name: 'alpha-team', settings: preset }], default_preset: null }
      : { defaults: preset, effective: preset, override: preset, preset_name: null }
  )

  const beta = vi.fn((method: string) =>
    method === 'delegation.presets'
      ? new Promise(resolve => (resolveBeta = resolve))
      : Promise.resolve({ defaults: preset, effective: preset, override: preset, preset_name: 'beta-team' })
  )

  const menu = (profile: string, request: unknown) => (
    <DropdownMenu open>
      <DropdownMenuContent>
        <SubagentSettingsMenuRow connectionId="remote" profile={profile} request={request as never} sessionId="chat-a" />
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const { rerender } = render(menu('alpha', alpha))
  await openSubagents()
  expect(await screen.findByRole('menuitem', { name: /alpha-team/ })).toBeTruthy()

  // Same mounted menu, switched to a second owner whose list is still in flight.
  rerender(menu('beta', beta))
  expect(screen.queryByRole('menuitem', { name: /alpha-team/ })).toBeNull()

  resolveBeta({ presets: [{ name: 'beta-team', settings: preset }], default_preset: null })
  await openSubagents()
  fireEvent.click(await screen.findByRole('menuitem', { name: /beta-team/ }))
  await waitFor(() =>
    expect(beta).toHaveBeenCalledWith('delegation.settings', {
      profile: 'beta',
      session_id: 'chat-a',
      preset_name: 'beta-team'
    })
  )
  expect(alpha.mock.calls.filter(call => JSON.stringify(call).includes('preset_name'))).toHaveLength(0)
})

it.each([
  ['hides the entry on a backend that predates per-chat subagent settings', { code: -32601, message: 'Method not found' }, false],
  ['keeps the entry through a transient failure', new Error('timeout'), true]
])('%s', async (_label, failure, shown) => {
  const request = vi.fn(async () => {
    throw failure
  })

  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SubagentSettingsMenuRow profile="alpha" request={request as never} sessionId="chat-a" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await waitFor(() => expect(request).toHaveBeenCalledWith('delegation.settings', { profile: 'alpha', session_id: 'chat-a' }))
  await waitFor(() => expect(Boolean(screen.queryByRole('menuitem', { name: /Subagents/ }))).toBe(shown))
})
