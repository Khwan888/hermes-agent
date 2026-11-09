import type { SubagentSnapshot } from '@hermes/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'

import { SubagentPageBar } from './subagent-page-bar'

vi.mock('./composer/status-stack/use-subagent-snapshot', () => ({ useSubagentSnapshot: vi.fn() }))
vi.mock('@/store/session-states', () => ({ requestForOwnedSession: (...args: unknown[]) => request(...args) }))
const request = vi.fn()

const child: SubagentSnapshot = {
  subagent_id: 'alpha',
  child_session_id: 'stored-alpha',
  status: 'running',
  started_at: 1,
  model: 'wrong-launch-model',
  route: {
    provider: 'mock',
    model: 'actual-model',
    effective_effort: 'high',
    requested_effort: 'low',
    wire_effort: 'high',
    effort_source: 'configured',
    reasoning_status: 'enabled',
    fallback_activated: false,
    observed: true
  },
  usage: {
    context_tokens: 1200,
    context_window: 64000,
    prompt_tokens: 1200,
    input_tokens: 300,
    cached_tokens: 900,
    output_tokens: 60,
    tokens_per_second: 30,
    generation_seconds: null
  }
}

function draw(subject: SubagentSnapshot | null = child, running = true) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SubagentPageBar
        parentSessionId="parent"
        running={running}
        sessionId="viewer-runtime"
        storedSessionId="stored-alpha"
        subject={subject}
      />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  request.mockReset()
})

it('shows every diagnostic by default, independent of (and without touching) the main statusbar readouts', () => {
  // Fresh profile: the main statusbar hides context / cache / speed by default.
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  const before = [...$statusbarHiddenIds.get()]

  for (const id of ['context-usage', 'cache-hit-rate', 'tokens-per-second']) {
    expect(before).toContain(id)
  }

  const { container } = draw()
  expect(container.querySelector('[data-subagent-metric="route"]')?.textContent).toContain('actual-model · high')
  expect(container.querySelector('[data-subagent-metric="timer"]')).toBeTruthy()
  expect(container.querySelector('[data-subagent-metric="context"]')?.textContent).toContain('1.2k / 64k')
  expect(container.querySelector('[data-subagent-metric="cache"]')?.textContent).toContain('75%')
  expect(container.querySelector('[data-subagent-metric="speed"]')?.textContent).toContain('30 t/s')

  // The main page's readout preferences stay exactly as they were.
  expect($statusbarHiddenIds.get()).toEqual(before)
})

it('measures the child, not the viewer; missing provider usage is unavailable, never zero', () => {
  const { container, rerender } = draw()
  expect(container.querySelector('[data-subagent-metric="route"]')?.textContent).toContain('actual-model · high')
  expect(container.querySelector('[data-subagent-metric="cache"]')?.textContent).toContain('75%')
  expect(container.querySelector('[data-subagent-metric="context"]')?.textContent).toContain('1.2k / 64k')
  expect(container.querySelector('[data-subagent-metric="speed"]')?.textContent).toContain('30 t/s')
  rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <SubagentPageBar
        parentSessionId="parent"
        running
        sessionId="viewer-runtime"
        storedSessionId="stored-alpha"
        subject={{ ...child, usage: null }}
      />
    </I18nProvider>
  )

  for (const metric of ['context', 'cache', 'speed']) {
    expect(container.querySelector(`[data-subagent-metric="${metric}"]`)?.textContent).toContain('Unavailable')
  }
})
it('steers and stops through the attached viewer, never prompt.submit or the parent transport', async () => {
  request.mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ found: true })
  draw()
  fireEvent.change(screen.getByPlaceholderText('Instructions for this subagent'), { target: { value: 'check errors' } })
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Queued for the next checkpoint'))
  expect(request.mock.calls[0][0]).toBe('viewer-runtime')
  expect(request.mock.calls[0][2]).toBe('subagent.steer')
  expect(request.mock.calls[0][3]).toEqual({ session_id: 'viewer-runtime', subagent_id: 'alpha', text: 'check errors' })
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(request.mock.calls[1][2]).toBe('subagent.interrupt'))
})
it('does not offer a new turn or live controls on finished subagent pages', () => {
  draw({ ...child, status: 'completed' }, false)
  expect(screen.queryByPlaceholderText('Instructions for this subagent')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(screen.getByText('Subagent finished · Read-only transcript')).toBeTruthy()
})
it('preserves rejected steer text and accepts optional delivered/relay receipts', async () => {
  request
    .mockResolvedValueOnce({ status: 'rejected' })
    .mockResolvedValueOnce({ status: 'queued', delivered_at: 2, relayed_to: ['nested-a', 'nested-b'] })
  draw()
  const input = screen.getByPlaceholderText('Instructions for this subagent') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'use checklist' } })
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
  await screen.findByRole('alert')
  expect(input.value).toBe('use checklist')
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Delivered · Relayed to 2 subagents'))
})
