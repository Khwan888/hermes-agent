import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { type SubagentPresetLibrary, SubagentPresetsSection } from './subagent-presets'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: request }))
afterEach(() => {
  cleanup()
  request.mockReset()
})

function library(names: string[], defaultPreset: null | string = null): SubagentPresetLibrary {
  return { presets: names.map(name => ({ name, settings: {} })), default_preset: defaultPreset }
}

it('saves, renames and deletes presets for the page owner and shows each write result', async () => {
  let names = ['fast-team']
  request.mockImplementation(async (_connection, _profile, _method, params) => {
    if (params.action === 'save') {
      names = [...names, params.name]
    } else if (params.action === 'rename') {
      names = names.map(name => (name === params.name ? params.new_name : name))
    } else if (params.action === 'delete') {
      names = names.filter(name => name !== params.name)
    }

    return library(names)
  })
  render(<SubagentPresetsSection scope={{ connectionId: 'remote-b', profile: 'research' }} />)
  const field = await screen.findByRole('textbox', { name: 'Preset name' })
  fireEvent.change(field, { target: { value: '  careful ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save current settings' }))
  await screen.findByRole('textbox', { name: 'Preset name: careful' })
  expect(request).toHaveBeenCalledWith('remote-b', 'research', 'delegation.presets', {
    profile: 'research',
    action: 'save',
    name: 'careful',
    settings: {}
  })
  expect((field as HTMLInputElement).value).toBe('')

  fireEvent.change(screen.getByRole('textbox', { name: 'Preset name: fast-team' }), {
    target: { value: 'renamed-team' }
  })
  fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0])
  await screen.findByRole('textbox', { name: 'Preset name: renamed-team' })
  expect(request).toHaveBeenCalledWith('remote-b', 'research', 'delegation.presets', {
    profile: 'research',
    action: 'rename',
    name: 'fast-team',
    new_name: 'renamed-team'
  })

  for (const button of screen.getAllByRole('button', { name: 'Delete' })) {
    fireEvent.click(button)
    await waitFor(() => expect(button.isConnected).toBe(false))
  }

  expect(await screen.findByText('No presets yet.')).toBeTruthy()
})

it('shows a backend refusal and keeps the last good list', async () => {
  request.mockImplementation(async (_connection, _profile, _method, params) => {
    if (params.action === 'save') {
      throw new Error('Subagent preset library subagent-presets.json is malformed')
    }

    return library(['kept'])
  })
  render(<SubagentPresetsSection scope="default" />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Preset name' }), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save current settings' }))
  expect((await screen.findByRole('alert')).textContent).toContain('subagent-presets.json is malformed')
  expect(screen.getByRole('textbox', { name: 'Preset name: kept' })).toBeTruthy()
})

it('hides itself on a backend without delegation.presets', async () => {
  request.mockRejectedValue(new Error('Method not found: delegation.presets'))
  const { container } = render(<SubagentPresetsSection scope="default" />)
  await waitFor(() => expect(request).toHaveBeenCalled())
  await act(async () => {})
  expect(container.textContent).toBe('')
})

it('never offers a previous owner’s presets while the next owner loads', async () => {
  let resolveSecond: (value: SubagentPresetLibrary) => void = () => {}
  request.mockImplementation(async (_connection, profile) =>
    profile === 'first' ? library(['first-only']) : new Promise(resolve => (resolveSecond = resolve))
  )
  const { rerender } = render(<SubagentPresetsSection scope={{ profile: 'first' }} />)
  await screen.findByRole('textbox', { name: 'Preset name: first-only' })
  rerender(<SubagentPresetsSection scope={{ profile: 'second' }} />)
  expect(screen.queryByRole('textbox', { name: 'Preset name: first-only' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  await act(async () => resolveSecond(library(['second-only'])))
  await screen.findByRole('textbox', { name: 'Preset name: second-only' })
  expect(request.mock.calls.every(([, , , params]) => params.action === undefined)).toBe(true)
})
