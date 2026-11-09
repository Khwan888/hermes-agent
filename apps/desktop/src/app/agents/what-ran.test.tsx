import type { SubagentRoute } from '@hermes/shared'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { type SubagentNode } from '@/store/subagents'

import { SubagentRow } from './index'

// jsdom has no Web Animations API; route text is independent of entrance motion.
vi.mock('@/lib/use-enter-animation', () => ({ useEnterAnimation: () => undefined }))

const route: SubagentRoute = {
  provider: 'openrouter',
  model: 'served/model',
  requested_effort: 'high',
  wire_effort: 'low',
  effective_effort: 'medium',
  effort_source: 'default',
  reasoning_status: 'enabled',
  observed: true,
  fallback_activated: true
}

const node = (observedRoute?: SubagentRoute): SubagentNode => ({
  id: 'child',
  parentId: null,
  parentSessionId: 'owner',
  sessionId: 'child-session',
  goal: 'Check what ran',
  model: 'stale/model',
  route: observedRoute,
  status: 'completed',
  taskCount: 1,
  taskIndex: 0,
  startedAt: 1000,
  updatedAt: 2000,
  durationSeconds: 8,
  filesRead: [],
  filesWritten: [],
  stream: [],
  children: []
})

function draw(observedRoute?: SubagentRoute) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SubagentRow node={node(observedRoute)} nowMs={2000} />
    </I18nProvider>
  )
}

afterEach(cleanup)

it('shows provider, actual model, effective default effort and activated fallback in the existing subtitle', () => {
  const { container } = draw(route)
  expect(container.textContent).toContain('openrouter · served/model · medium (default) · Fallback')
  expect(container.textContent).not.toContain('stale/model')
  expect(container.textContent).not.toContain('high')
  expect(container.textContent).not.toContain('low')
  const row = container.querySelector('[data-subagent-id="child"]')
  expect(row?.getAttribute('data-session-id')).toBe('child-session')
  expect(row?.getAttribute('data-parent-session-id')).toBe('owner')
  expect(row?.getAttribute('data-subagent-status')).toBe('completed')
})

it.each([
  ['disabled', 'Reasoning off'],
  ['unknown', 'Effort unknown'],
  ['enabled', 'Effort unknown']
] as const)('distinguishes %s reasoning with a null effort', (reasoning_status, label) => {
  const { container } = draw({ ...route, effective_effort: null, reasoning_status, fallback_activated: null })
  expect(container.textContent).toContain(label)
  expect(container.textContent).not.toContain('Fallback')

  if (reasoning_status !== 'disabled') {
    expect(container.textContent).not.toContain('Reasoning off')
  }
})

it('labels configured effort as intent before any request is observed', () => {
  const { container } = draw({
    ...route,
    requested_effort: 'ultra',
    wire_effort: null,
    effective_effort: null,
    effort_source: 'configured',
    reasoning_status: 'unknown',
    observed: false,
    fallback_activated: null
  })

  expect(container.textContent).toContain('openrouter · served/model · ultra (configured, not yet observed)')
})

it('keeps the legacy subtitle for older backends with no route', () => {
  const { container } = draw()
  expect(container.textContent).toContain('stale/model')
  expect(container.textContent).not.toContain('Effort unknown')
  expect(container.textContent).not.toContain('Fallback')
})
