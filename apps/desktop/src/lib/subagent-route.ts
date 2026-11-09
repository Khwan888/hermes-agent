import type { SubagentRoute } from '@hermes/shared'

import type { Translations } from '@/i18n/types'

const OFF = new Set(['none', 'off'])

/** Effort shown for a route that has not dispatched a request yet: intent, labelled as such. */
function unobservedEffort(route: SubagentRoute, a: Translations['agents']): string {
  const requested = route.requested_effort

  if (!requested) {
    return a.effortUnknown
  }

  return a.configuredEffort(OFF.has(requested) ? a.reasoningOff : requested)
}

/** Only observed effective effort is display truth; requested/wire values are diagnostics. */
export function subagentRouteSubtitle(
  route: SubagentRoute | undefined,
  legacyModel: string | undefined,
  a: Translations['agents']
): string[] {
  if (!route) {
    return legacyModel ? [legacyModel] : []
  }

  const effort = !route.observed
    ? unobservedEffort(route, a)
    : route.reasoning_status === 'disabled'
      ? a.reasoningOff
      : route.effective_effort
        ? route.effort_source === 'default'
          ? a.defaultEffort(route.effective_effort)
          : route.effective_effort
        : a.effortUnknown

  return [
    route.provider || a.providerUnknown,
    route.model || legacyModel || a.modelUnknown,
    effort,
    ...(route.fallback_activated === true ? [a.routeFallback] : [])
  ]
}
