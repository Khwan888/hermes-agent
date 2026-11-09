import { REASONING_EFFORTS } from '@hermes/shared'
import { useEffect, useState } from 'react'

import { displayProviders, useOwnerCatalog } from '@/app/settings/delegation-model-provider-field'
import { ModelSelect } from '@/app/settings/model-select'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { findCatalogProvider } from '@/lib/model-options'

import {
  $subagentDrafts,
  cacheSubagentSettings,
  setSubagentDraft,
  subagentOwnerKey,
  type SubagentPresetLibrary,
  type SubagentRequester,
  subagentSessionKey,
  type SubagentSettings,
  type SubagentSettingsResult
} from './subagent-settings-data'

const INHERIT = '__inherit__'
const ROUTE_TRANSPORT = new Set(['base_url', 'api_key', 'api_mode', 'command', 'args', 'request_overrides'])

/** A new provider brings its own endpoint: drop the old route's transport and credential refs (top level or named). */
export function withRouteProvider<T extends object>(route: T, provider: string): T {
  if (((route as { provider?: string }).provider ?? '') === provider) {
    return route
  }

  const kept = Object.entries(route).filter(([key]) => !ROUTE_TRANSPORT.has(key) && !key.startsWith('_credential_'))

  return { ...Object.fromEntries(kept), provider, model: '' } as T
}

interface SubagentSettingsDialogProps {
  connectionId?: string | null
  profile: string
  sessionId?: string | null
  request: SubagentRequester
  onClose: () => void
}

export function SubagentSettingsDialog({
  connectionId,
  profile,
  sessionId,
  request,
  onClose
}: SubagentSettingsDialogProps) {
  const { t } = useI18n()
  const s = t.settings.model.subagents
  const c = s.quick
  const [settings, setSettings] = useState<SubagentSettingsResult | null>(null)
  const [draft, setDraft] = useState<SubagentSettings | null>(null)
  const [library, setLibrary] = useState<SubagentPresetLibrary | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const params = { profile, ...(sessionId ? { session_id: sessionId } : {}) }
  const key = subagentSessionKey(connectionId, profile, sessionId)

  useEffect(() => {
    let current = true
    void Promise.all([
      request<SubagentSettingsResult>('delegation.settings', {
        profile,
        ...(sessionId ? { session_id: sessionId } : {})
      }),
      // The preset library is optional: a backend without it still edits this chat, with no preset actions.
      request<SubagentPresetLibrary>('delegation.presets', { profile }).catch(e => {
        if (isMissingRpcMethod(e)) {
          return null
        }

        throw e
      })
    ])
      .then(([result, presets]) => {
        if (!current) {
          return
        }

        const local = !sessionId && $subagentDrafts.get()[subagentOwnerKey(connectionId, profile)]
        setSettings(result)
        setDraft({ ...result.effective, ...(local ? local.override : {}) })
        setLibrary(presets)
        cacheSubagentSettings(key, result)
      })
      .catch(e => {
        // A missing method means this backend has no per-chat settings; anything else is transient.
        // Never fall back to a profile-wide write.
        if (current) {
          setError(isMissingRpcMethod(e) ? c.unavailable : `${c.failed} ${e instanceof Error ? e.message : ''}`)
        }
      })

    return () => {
      current = false
    }
  }, [connectionId, profile, sessionId, request, key, c.unavailable, c.failed])

  async function apply(override: Partial<SubagentSettings> | null, presetName?: string) {
    if (!settings || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      if (sessionId) {
        await request('delegation.settings', {
          ...params,
          ...(presetName ? { preset_name: presetName } : { override })
        })
        const confirmed = await request<SubagentSettingsResult>('delegation.settings', params)
        cacheSubagentSettings(key, confirmed)
        setSettings(confirmed)
        setDraft(confirmed.effective)
      } else {
        setSubagentDraft(connectionId, profile, { override, preset_name: presetName ?? null })
        setDraft({ ...settings.defaults, ...override })
      }
    } catch (e) {
      setError(`${c.failed} ${e instanceof Error ? e.message : ''}`)
    } finally {
      setBusy(false)
    }
  }

  async function savePreset() {
    if (!draft || !name.trim() || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      await request('delegation.presets', { profile, action: 'save', name: name.trim(), settings: draft })
      setLibrary(await request<SubagentPresetLibrary>('delegation.presets', { profile }))
      setName('')
    } catch (e) {
      setError(`${c.failed} ${e instanceof Error ? e.message : ''}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="max-w-lg" data-slot="subagent-settings-dialog">
        <DialogHeader>
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.intro}</DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {settings?.pending_schema && (
          <p className="text-xs text-muted-foreground" role="status">
            {c.pendingSchema}
          </p>
        )}
        {draft && settings && (
          <>
            {library && library.presets.length > 0 && (
              <div aria-label={c.presets} className="flex flex-wrap gap-1" role="group">
                {library.presets.map(preset => (
                  <Button
                    disabled={busy}
                    key={preset.name}
                    onClick={() => void apply(preset.settings, preset.name)}
                    size="sm"
                    variant="secondary"
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
            )}
            <SubagentQuickFields
              available={settings.available_backends}
              connectionId={connectionId}
              defaults={settings.defaults}
              onChange={setDraft}
              profile={profile}
              value={draft}
            />
            {library && (
              <div className="flex items-end gap-2">
                <Field htmlFor="subagent-preset-name" label={c.presetName}>
                  <Input id="subagent-preset-name" onChange={event => setName(event.target.value)} value={name} />
                </Field>
                <Button disabled={busy || !name.trim()} onClick={() => void savePreset()} size="sm" variant="secondary">
                  {c.savePreset}
                </Button>
              </div>
            )}
            <DialogFooter>
              <Button disabled={busy} onClick={() => void apply(null)} size="sm" variant="text">
                {c.reset}
              </Button>
              <Button disabled={busy} onClick={() => void apply(draft)} size="sm">
                {c.apply}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface SubagentQuickFieldsProps {
  value: SubagentSettings
  defaults: SubagentSettings
  available: string[]
  connectionId?: string | null
  profile: string
  onChange: (settings: SubagentSettings) => void
}

function configuredRouteNames(settings: SubagentSettings): string[] {
  const config = settings.backends[settings.backend]
  const entries = settings.backend === 'profile_routes' ? (config?.profiles ?? []) : (config?.options ?? [])

  return entries.map(entry => (typeof entry === 'string' ? entry : entry.name))
}

type RouteOption = NonNullable<SubagentSettings['backends'][string]['options']>[number]

/** The route's provider picker. Empty provider = inherit from the main agent. */
function SubagentProviderField({
  namedRoute,
  onProvider,
  providers,
  route
}: {
  namedRoute?: RouteOption
  onProvider: (provider: string) => void
  providers: Parameters<typeof displayProviders>[0]
  route: { provider?: string }
}) {
  const { t } = useI18n()
  const s = t.settings.model.subagents
  // A named route must name a provider or carry its own endpoint (the backend refuses anything else),
  // and picking a different provider drops the old endpoint. So "Inherit from main agent" is offered
  // for the top-level route, or for a named route that already inherits with its own endpoint.
  const canInherit = !namedRoute || Boolean(!namedRoute.provider && namedRoute.base_url)

  return (
    <Field htmlFor="subagent-provider" label={s.providerLabel}>
      <Select
        onValueChange={provider => onProvider(provider === INHERIT ? '' : provider)}
        value={route.provider || (canInherit ? INHERIT : '')}
      >
        <SelectTrigger id="subagent-provider">
          <SelectValue placeholder={s.routing.providerPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          {canInherit && <SelectItem value={INHERIT}>{s.inherit}</SelectItem>}
          {displayProviders(providers, route.provider ?? '').map(provider => (
            <SelectItem key={provider.slug} value={provider.slug}>
              {provider.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function SubagentQuickFields({
  value,
  defaults,
  available,
  connectionId,
  profile,
  onChange
}: SubagentQuickFieldsProps) {
  const { t } = useI18n()
  const s = t.settings.model.subagents
  const c = s.quick
  const r = s.routing
  const { providers } = useOwnerCatalog({ connectionId: connectionId ?? undefined, profile })
  const config = value.backends[value.backend]
  const options = config?.options ?? []

  const selectedRoute =
    value.backend === 'model_map' ? options.find(route => route.name === config?.default) : undefined

  const route = selectedRoute ?? value
  const selectedProvider = findCatalogProvider(providers, route.provider ?? '')

  const updateRoute = (edit: <T extends object>(route: T) => T) => {
    if (selectedRoute) {
      onChange({
        ...value,
        backends: {
          ...value.backends,
          model_map: {
            ...config,
            options: options.map(item => (item.name === selectedRoute.name ? edit(item) : item))
          }
        }
      })
    } else {
      onChange(edit(value))
    }
  }

  const setRouteFields = (fields: Partial<SubagentSettings>) => updateRoute(route => ({ ...route, ...fields }))

  const routeNames = configuredRouteNames(value)

  return (
    <div className="grid gap-3">
      <Field htmlFor="subagent-mode" label={r.title}>
        <Select
          onValueChange={backend =>
            onChange({ ...value, backend, backends: { ...defaults.backends, ...value.backends } })
          }
          value={value.backend}
        >
          <SelectTrigger id="subagent-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...new Set([value.backend, ...available])].map(backend => (
              <SelectItem disabled={!available.includes(backend)} key={backend} value={backend}>
                {r.modes[backend as keyof typeof r.modes]?.label ?? backend}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {value.backend !== 'default' && routeNames.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {value.backend === 'profile_routes' ? r.profileEmpty : r.modelRoutesEmpty}
        </p>
      )}
      {value.backend !== 'default' && routeNames.length > 0 && (
        <Field htmlFor="subagent-default-route" label={r.defaultBadge}>
          <Select
            onValueChange={name =>
              onChange({ ...value, backends: { ...value.backends, [value.backend]: { ...config, default: name } } })
            }
            value={config?.default ?? undefined}
          >
            <SelectTrigger id="subagent-default-route">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {routeNames.map(name => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {(value.backend === 'default' || selectedRoute) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SubagentProviderField
            namedRoute={selectedRoute}
            onProvider={provider => updateRoute(route => withRouteProvider(route, provider))}
            providers={providers}
            route={route}
          />
          <Field label={s.modelLabel}>
            <ModelSelect
              aria-label={s.modelLabel}
              models={selectedProvider?.models ?? []}
              onValueChange={model => setRouteFields({ model })}
              provider={selectedProvider}
              providerSlug={route.provider ?? ''}
              value={route.model ?? ''}
            />
          </Field>
          <Field htmlFor="subagent-effort" label={r.effortLabel}>
            <Select
              onValueChange={effort => setRouteFields({ reasoning_effort: effort === INHERIT ? '' : effort })}
              value={route.reasoning_effort || INHERIT}
            >
              <SelectTrigger id="subagent-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{r.effortInherit}</SelectItem>
                {['none', ...REASONING_EFFORTS].map(effort => (
                  <SelectItem key={effort} value={effort}>
                    {effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="subagent-depth" label={c.depth}>
          <Input
            id="subagent-depth"
            min={1}
            onChange={event => onChange({ ...value, max_spawn_depth: Number(event.target.value) })}
            type="number"
            value={value.max_spawn_depth}
          />
        </Field>
        <Field htmlFor="subagent-concurrency" label={c.concurrency}>
          <Input
            id="subagent-concurrency"
            min={1}
            onChange={event => onChange({ ...value, max_concurrent_children: Number(event.target.value) })}
            type="number"
            value={value.max_concurrent_children}
          />
        </Field>
      </div>
    </div>
  )
}
