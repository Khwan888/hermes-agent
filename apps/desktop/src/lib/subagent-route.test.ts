import type { SubagentRoute } from '@hermes/shared'
import { expect, it } from 'vitest'

import { BUNDLED_LOCALES, TRANSLATIONS } from '@/i18n/catalog'

import { subagentRouteSubtitle } from './subagent-route'

const route: SubagentRoute = {
  provider: 'provider',
  model: 'actual/model',
  requested_effort: 'high',
  wire_effort: 'low',
  effective_effort: 'medium',
  effort_source: 'configured',
  reasoning_status: 'enabled',
  observed: true,
  fallback_activated: false
}

it('does not label configured effort as default or an inactive fallback as activated', () => {
  expect(subagentRouteSubtitle(route, 'stale/model', TRANSLATIONS.en.agents)).toEqual([
    'provider',
    'actual/model',
    'medium'
  ])
})

it('lets explicit disabled status override an earlier effort value', () => {
  expect(subagentRouteSubtitle({ ...route, reasoning_status: 'disabled' }, undefined, TRANSLATIONS.en.agents)).toEqual([
    'provider',
    'actual/model',
    'Reasoning off'
  ])
})

it('labels unknown route fields rather than inferring disabled from nulls', () => {
  expect(
    subagentRouteSubtitle(
      { ...route, provider: null, model: null, effective_effort: null, reasoning_status: 'unknown' },
      undefined,
      TRANSLATIONS.en.agents
    )
  ).toEqual(['Provider unknown', 'Model unknown', 'Effort unknown'])
})

it.each([
  ['ultra', 'ultra (configured, not yet observed)'],
  ['none', 'Reasoning off (configured, not yet observed)'],
  [null, 'Effort unknown']
] as const)('shows configured %s effort as intent until a request is observed', (requested_effort, label) => {
  const unobserved: SubagentRoute = {
    ...route,
    requested_effort,
    wire_effort: null,
    effective_effort: null,
    effort_source: requested_effort ? 'configured' : 'unknown',
    reasoning_status: 'unknown',
    observed: false
  }

  expect(subagentRouteSubtitle(unobserved, undefined, TRANSLATIONS.en.agents)).toEqual([
    'provider',
    'actual/model',
    label
  ])
})

it('never presents an unobserved effective value as actual', () => {
  const stale = { ...route, observed: false, requested_effort: 'high', effective_effort: 'high' }
  expect(subagentRouteSubtitle(stale, undefined, TRANSLATIONS.en.agents)[2]).toBe(
    'high (configured, not yet observed)'
  )
})

it.each(BUNDLED_LOCALES)('supplies route copy in bundled locale %s', locale => {
  const a = TRANSLATIONS[locale].agents
  const subtitle = subagentRouteSubtitle({ ...route, effort_source: 'default', fallback_activated: true }, undefined, a)
  expect(subtitle).toEqual(['provider', 'actual/model', a.defaultEffort('medium'), a.routeFallback])
  expect(a.configuredEffort('high')).toContain('high')

  if (locale !== 'en') {
    expect(a.configuredEffort('high')).not.toBe(TRANSLATIONS.en.agents.configuredEffort('high'))
  }

  for (const key of ['providerUnknown', 'modelUnknown', 'reasoningOff', 'effortUnknown', 'routeFallback'] as const) {
    expect(a[key]).toBeTruthy()

    if (locale !== 'en' && key !== 'routeFallback') {
      expect(a[key]).not.toBe(TRANSLATIONS.en.agents[key])
    }
  }
})
