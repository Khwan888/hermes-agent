import { useCallback, useEffect, useRef, useState } from 'react'

import { capabilityScoped, type ProfileScope } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { Bookmark } from '@/lib/icons'
import { requestGatewayForAgent } from '@/store/gateway'

import { SettingsSection } from '../primitives'

/** `delegation.presets` result: public settings only; credential references never leave the backend. */
export interface SubagentPresetLibrary {
  presets: { name: string; settings: Record<string, unknown> }[]
  default_preset: null | string
}

const PROFILE_SETTINGS = '__profile_settings__'
const UNSUPPORTED = /method not found|not supported|unknown method|-32601/i

/**
 * Settings › Model › Subagents › Presets. The library belongs to the page's owner (connection + profile):
 * a loaded list is shown only while that owner is still current, and a write started for one owner
 * never lands in another's view. Older backends without `delegation.presets` hide the section.
 */
export function SubagentPresetsSection({ scope }: { scope: ProfileScope }) {
  const { t } = useI18n()
  const c = t.settings.model.subagents.presets
  const owner = capabilityScoped(scope)
  const profile = owner.profile || 'default'
  const connectionId = owner.connectionId ?? null
  const ownerKey = `${connectionId ?? ''}\u0000${profile}`
  const currentOwner = useRef(ownerKey)
  currentOwner.current = ownerKey

  const [loaded, setLoaded] = useState<{ key: string; library: SubagentPresetLibrary } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [unsupported, setUnsupported] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')

  const request = useCallback(
    (params: Record<string, unknown> = {}) =>
      requestGatewayForAgent<SubagentPresetLibrary>(connectionId, profile, 'delegation.presets', {
        ...params,
        profile
      }),
    [connectionId, profile]
  )

  useEffect(() => {
    let current = true
    setName('')
    void request()
      .then(library => {
        if (current) {
          setLoaded({ key: ownerKey, library })
        }
      })
      .catch(error => {
        if (!current) {
          return
        }

        if (UNSUPPORTED.test(String(error))) {
          setUnsupported(ownerKey)
        } else {
          setFailure({ key: ownerKey, message: c.failed })
        }
      })

    return () => {
      current = false
    }
  }, [request, ownerKey, c.failed])

  const library = loaded?.key === ownerKey ? loaded.library : null
  const error = failure?.key === ownerKey ? failure.message : ''

  async function mutate(params: Record<string, unknown>) {
    if (busy || !library) {
      return false
    }

    const key = ownerKey
    setBusy(true)
    setFailure(null)

    try {
      const next = await request(params)

      if (currentOwner.current === key) {
        setLoaded({ key, library: next })
      }

      return true
    } catch (e) {
      if (currentOwner.current === key) {
        const detail = e instanceof Error ? e.message : ''
        setFailure({ key, message: detail ? `${c.failed} ${detail}` : c.failed })
      }

      return false
    } finally {
      setBusy(false)
    }
  }

  if (unsupported === ownerKey || (!library && !error)) {
    return null
  }

  return (
    <SettingsSection icon={Bookmark} title={c.title}>
      <p className="mb-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{c.intro}</p>
      {error && (
        <p className="mb-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {library && (
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            {c.defaultPreset}
            <Select
              disabled={busy}
              onValueChange={value =>
                void mutate({ action: 'default', name: value === PROFILE_SETTINGS ? null : value })
              }
              value={library.default_preset ?? PROFILE_SETTINGS}
            >
              <SelectTrigger aria-label={c.defaultPreset}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROFILE_SETTINGS}>{c.profileDefault}</SelectItem>
                {library.presets.map(preset => (
                  <SelectItem key={preset.name} value={preset.name}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {library.presets.length === 0 && <p className="text-xs text-muted-foreground">{c.empty}</p>}
          {library.presets.map(preset => (
            <PresetRow
              busy={busy}
              key={`${ownerKey}\u0000${preset.name}`}
              name={preset.name}
              onDelete={() => void mutate({ action: 'delete', name: preset.name })}
              onRename={newName => void mutate({ action: 'rename', name: preset.name, new_name: newName })}
            />
          ))}
          <div className="flex items-center gap-2">
            <Input
              aria-label={c.presetName}
              maxLength={80}
              onChange={event => setName(event.target.value)}
              placeholder={c.presetName}
              value={name}
            />
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                // `{}` saves a snapshot of the profile's current subagent settings (the section above).
                void mutate({ action: 'save', name: name.trim(), settings: {} }).then(saved => saved && setName(''))
              }
              size="sm"
              variant="secondary"
            >
              {c.savePreset}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

function PresetRow({
  name,
  busy,
  onRename,
  onDelete
}: {
  name: string
  busy: boolean
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const c = useI18n().t.settings.model.subagents.presets
  const [draft, setDraft] = useState(name)

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={`${c.presetName}: ${name}`}
        maxLength={80}
        onChange={event => setDraft(event.target.value)}
        value={draft}
      />
      <Button
        disabled={busy || !draft.trim() || draft.trim() === name}
        onClick={() => onRename(draft.trim())}
        size="sm"
        variant="text"
      >
        {c.rename}
      </Button>
      <Button disabled={busy} onClick={onDelete} size="sm" variant="text">
        {c.remove}
      </Button>
    </div>
  )
}
