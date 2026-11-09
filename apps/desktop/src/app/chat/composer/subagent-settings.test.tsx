import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { clearSubagentDraft, setSubagentDraft, subagentDraftParams, subagentSettingsDiffer } from './subagent-settings-data'
import { SubagentQuickFields, SubagentSettingsDialog, withRouteProvider } from './subagent-settings-dialog'

const catalog = vi.hoisted(() => ({ providers: [] as Array<{ slug: string; name: string; models: string[] }> }))

vi.mock('@/app/settings/delegation-model-provider-field', () => ({
  useOwnerCatalog: () => ({ providers: catalog.providers }),
  displayProviders: () => catalog.providers
}))
vi.mock('@/app/settings/model-select', () => ({ ModelSelect: () => null }))

const defaults = {
  backend: 'default',
  model: '',
  provider: '',
  reasoning_effort: '',
  max_spawn_depth: 2,
  max_concurrent_children: 10,
  backends: {}
}

const fast = { ...defaults, model: 'route-b', provider: 'mock-b', reasoning_effort: 'high', max_spawn_depth: 1 }
afterEach(() => {
  cleanup()
  catalog.providers = []
})

it('selects a preset for this chat only, and reset follows profile defaults', async () => {
  let selected = false

  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'delegation.presets') {
      return { presets: [{ name: 'fast-team', settings: fast }], default_preset: null }
    }

    if (params.preset_name) {
      selected = true
    }

    if ('override' in params && params.override === null) {
      selected = false
    }

    return {
      override: selected ? fast : null,
      effective: selected ? fast : defaults,
      defaults,
      available_backends: ['default'],
      preset_name: params.preset_name ?? null
    }
  })

  render(
    <SubagentSettingsDialog
      connectionId="remote-a"
      onClose={() => {}}
      profile="alpha"
      request={request as never}
      sessionId="chat-1"
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'fast-team' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('delegation.settings', {
      profile: 'alpha',
      session_id: 'chat-1',
      preset_name: 'fast-team'
    })
  )
  await waitFor(() =>
    expect((screen.getByRole('spinbutton', { name: 'Nesting depth' }) as HTMLInputElement).value).toBe('1')
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reset to profile default' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('delegation.settings', {
      profile: 'alpha',
      session_id: 'chat-1',
      override: null
    })
  )
  await waitFor(() =>
    expect((screen.getByRole('spinbutton', { name: 'Nesting depth' }) as HTMLInputElement).value).toBe('2')
  )
  expect(request.mock.calls.every(([, p]) => !p?.session_id || p.session_id === 'chat-1')).toBe(true)
})

it('keeps a draft choice owner-qualified and consumes it exactly once on first send', () => {
  setSubagentDraft('remote-a', 'alpha', { override: fast, preset_name: 'fast-team' })
  expect(subagentDraftParams('remote-b', 'alpha')).toEqual({})
  expect(subagentDraftParams('remote-a', 'beta')).toEqual({})
  const sent = subagentDraftParams('remote-a', 'alpha')
  expect(sent).toEqual({ delegation_override: fast, delegation_preset: 'fast-team' })
  clearSubagentDraft('remote-a', 'alpha', sent)
  expect(subagentDraftParams('remote-a', 'alpha')).toEqual({})
})

it('edits depth and concurrency without changing the profile default', () => {
  const changed = vi.fn()

  function Form() {
    const [value, setValue] = useState(defaults)

    return (
      <SubagentQuickFields
        available={['default']}
        defaults={defaults}
        onChange={next => {
          changed(next)
          setValue(next)
        }}
        profile="alpha"
        value={value}
      />
    )
  }

  render(<Form />)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Nesting depth' }), { target: { value: '1' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Max subagents at once' }), { target: { value: '3' } })
  expect(changed).toHaveBeenLastCalledWith({ ...defaults, max_spawn_depth: 1, max_concurrent_children: 3 })
  expect(defaults.max_spawn_depth).toBe(2)
  expect(defaults.max_concurrent_children).toBe(10)
})

it('keeps profile-default settings visually quiet regardless of property order or inactive route libraries', () => {
  expect(subagentSettingsDiffer({ ...defaults, backends: { inactive: { default: 'other' } } }, defaults)).toBe(false)
  expect(subagentSettingsDiffer(fast, defaults)).toBe(true)
})

it('selects the default named route without editing the profile route library', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const changed = vi.fn()

  const modelMap = {
    default: 'route-a',
    options: [
      { name: 'route-a', model: 'model-a' },
      { name: 'route-b', model: 'model-b' }
    ]
  }

  render(
    <SubagentQuickFields
      available={['default', 'model_map']}
      defaults={defaults}
      onChange={changed}
      profile="alpha"
      value={{ ...defaults, backend: 'model_map', backends: { model_map: modelMap } }}
    />
  )
  fireEvent.keyDown(screen.getByLabelText('Default'), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'route-b' }))
  expect(changed).toHaveBeenCalledWith({
    ...defaults,
    backend: 'model_map',
    backends: { model_map: { ...modelMap, default: 'route-b' } }
  })
  expect(modelMap.default).toBe('route-a')
})

it('replaces a named route\'s whole transport when its provider changes', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  catalog.providers = [{ slug: 'openrouter', name: 'OpenRouter', models: [] }]
  const changed = vi.fn()

  const endpoint = {
    name: 'route-a',
    description: 'quick',
    provider: 'custom',
    model: 'old-model',
    base_url: 'http://127.0.0.1:9/v1',
    api_mode: 'anthropic_messages',
    request_overrides: { extra_body: { endpoint: 'old' } },
    _credential_ref: 'old'
  }

  const sibling = { name: 'route-b', provider: 'custom', model: 'b', base_url: 'http://127.0.0.1:8/v1' }
  const modelMap = { default: 'route-a', options: [endpoint, sibling] }

  render(
    <SubagentQuickFields
      available={['default', 'model_map']}
      defaults={defaults}
      onChange={changed}
      profile="alpha"
      value={{ ...defaults, backend: 'model_map', backends: { model_map: modelMap } }}
    />
  )
  fireEvent.keyDown(screen.getByLabelText('Subagent Provider'), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))
  expect(changed).toHaveBeenCalledWith({
    ...defaults,
    backend: 'model_map',
    backends: {
      model_map: {
        ...modelMap,
        options: [{ name: 'route-a', description: 'quick', provider: 'openrouter', model: '' }, sibling]
      }
    }
  })
  expect(endpoint.base_url).toBe('http://127.0.0.1:9/v1')
})

it('uses the same provider normalization for the top-level route and inherit', () => {
  const top = { ...defaults, provider: 'custom', model: 'm', base_url: 'http://127.0.0.1:9/v1' }

  expect(withRouteProvider(top, '')).toEqual({ ...defaults, provider: '', model: '' })
  expect(withRouteProvider(top, 'custom')).toBe(top)
})

it('offers "Inherit from main agent" only where the backend accepts it', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  catalog.providers = [{ slug: 'openrouter', name: 'OpenRouter', models: [] }]
  const named = { name: 'route-a', description: 'quick', provider: 'openrouter', model: 'm' }
  const ownEndpoint = { name: 'route-c', description: 'local', provider: '', model: 'm', base_url: 'http://127.0.0.1:9/v1' }
  const blank = { name: 'route-d', description: 'unset', provider: '', model: 'm' }

  const open = async (value: typeof defaults & Record<string, unknown>) => {
    const changed = vi.fn()

    const view = render(
      <SubagentQuickFields available={['default', 'model_map']} defaults={defaults} onChange={changed} profile="alpha" value={value} />
    )

    fireEvent.keyDown(screen.getByLabelText('Subagent Provider'), { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'OpenRouter' })
    const offered = screen.queryByRole('option', { name: 'Inherit from main agent' }) !== null
    const shown = screen.getByLabelText('Subagent Provider').textContent
    view.unmount()

    return { offered, shown }
  }

  const mapped = (route: string) => ({
    ...defaults,
    backend: 'model_map',
    backends: { model_map: { default: route, options: [named, ownEndpoint, blank] } }
  })

  // Top-level route: inheriting the main agent's route is valid.
  expect((await open(defaults)).offered).toBe(true)
  // A named route with a provider: inherit would drop its endpoint and the backend refuses it.
  expect((await open(mapped('route-a'))).offered).toBe(false)
  // A named route that already inherits with its own endpoint keeps the choice.
  expect(await open(mapped('route-c'))).toEqual({ offered: true, shown: 'Inherit from main agent' })
  // A named route with neither: no inherit, the picker asks for a provider instead.
  expect(await open(mapped('route-d'))).toEqual({ offered: false, shown: 'Choose a provider' })
})

it.each([
  ['a backend without per-chat subagent settings', { code: -32601, message: 'Method not found' }, /Update the backend/],
  ['a transient failure', new Error('socket closed'), /Could not update subagent settings\. socket closed/]
])('tells %s apart and offers no write', async (_label, failure, shown) => {
  const request = vi.fn(async (_method: string) => {
    throw failure
  })

  render(<SubagentSettingsDialog onClose={() => {}} profile="alpha" request={request as never} sessionId="chat-1" />)
  expect((await screen.findByRole('alert')).textContent).toMatch(shown)
  expect(screen.queryByRole('button', { name: 'Apply to this chat' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reset to profile default' })).toBeNull()
  // Never a profile-wide fallback: only the two reads were attempted.
  expect(request.mock.calls.map(([method]) => method).sort()).toEqual(['delegation.presets', 'delegation.settings'])
})

it('edits this chat on a backend without a preset library and hides preset actions', async () => {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'delegation.presets') {
      throw { code: -32601, message: 'Method not found' }
    }

    return {
      override: 'override' in params ? params.override : null,
      effective: defaults,
      defaults,
      available_backends: ['default'],
      preset_name: null
    }
  })

  render(<SubagentSettingsDialog onClose={() => {}} profile="alpha" request={request as never} sessionId="chat-1" />)
  expect(await screen.findByRole('button', { name: 'Apply to this chat' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save current as preset' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Subagent presets' })).toBeNull()
})
