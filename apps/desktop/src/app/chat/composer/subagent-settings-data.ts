import { atom } from 'nanostores'

export interface SubagentSettings {
  backend: string
  model: string
  provider: string
  reasoning_effort: string
  max_spawn_depth: number
  max_concurrent_children: number
  backends: Record<
    string,
    {
      default?: string | null
      options?: Array<{ name: string; model?: string; provider?: string; reasoning_effort?: string; base_url?: string }>
      profiles?: Array<string | { name: string }>
    }
  >
}
export interface SubagentSettingsResult {
  override: Partial<SubagentSettings> | null
  effective: SubagentSettings
  defaults: SubagentSettings
  available_backends: string[]
  preset_name: string | null
  pending_schema?: boolean
}
export interface SubagentPresetLibrary {
  presets: Array<{ name: string; settings: SubagentSettings }>
  default_preset: string | null
}
export type SubagentRequester = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
interface SubagentDraft {
  override: Partial<SubagentSettings> | null
  preset_name: string | null
}
export const $subagentSettings = atom<Record<string, SubagentSettingsResult>>({})
export const $subagentDrafts = atom<Record<string, SubagentDraft>>({})
export const subagentOwnerKey = (connection: string | null | undefined, profile: string) =>
  JSON.stringify([connection ?? '', profile])
export const subagentSessionKey = (connection: string | null | undefined, profile: string, sessionId?: string | null) =>
  JSON.stringify([connection ?? '', profile, sessionId ?? 'draft'])

export function setSubagentDraft(connection: string | null | undefined, profile: string, value: SubagentDraft) {
  $subagentDrafts.set({ ...$subagentDrafts.get(), [subagentOwnerKey(connection, profile)]: value })
}

export function subagentDraftParams(connection: string | null | undefined, profile: string): Record<string, unknown> {
  const draft = $subagentDrafts.get()[subagentOwnerKey(connection, profile)]

  return draft?.override
    ? { delegation_override: draft.override, ...(draft.preset_name ? { delegation_preset: draft.preset_name } : {}) }
    : {}
}

export function clearSubagentDraft(
  connection: string | null | undefined,
  profile: string,
  sent: Record<string, unknown>
) {
  const key = subagentOwnerKey(connection, profile)

  if ($subagentDrafts.get()[key]?.override === sent.delegation_override) {
    const { [key]: _removed, ...rest } = $subagentDrafts.get()
    $subagentDrafts.set(rest)
  }
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value) ?? ''
}

export function subagentSettingsDiffer(effective: SubagentSettings, defaults: SubagentSettings): boolean {
  const project = (settings: SubagentSettings) => ({
    backend: settings.backend || 'default',
    model: settings.model || '',
    provider: settings.provider || '',
    reasoning_effort: settings.reasoning_effort || '',
    max_spawn_depth: settings.max_spawn_depth,
    max_concurrent_children: settings.max_concurrent_children,
    route: settings.backends?.[settings.backend || 'default'] ?? {}
  })

  return stable(project(effective)) !== stable(project(defaults))
}

export function cacheSubagentSettings(key: string, result: SubagentSettingsResult) {
  $subagentSettings.set({ ...$subagentSettings.get(), [key]: result })
}
