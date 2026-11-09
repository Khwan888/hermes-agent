import { useEffect, useState } from 'react'

import { DropdownMenuItem, dropdownMenuRow, dropdownMenuSectionLabel } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { notify } from '@/store/notifications'

import {
  cacheSubagentSettings,
  setSubagentDraft,
  type SubagentPresetLibrary,
  type SubagentRequester,
  subagentSessionKey,
  type SubagentSettingsResult
} from './subagent-settings-data'

type Preset = SubagentPresetLibrary['presets'][number]

interface SubagentPresetOwner {
  connectionId?: string | null
  profile: string
  sessionId?: string | null
  request: SubagentRequester
}

/** The owner's saved presets, or null while loading / when the backend has none to offer.
 *  The list is keyed by its owner (connection + profile): a list fetched for a previous owner is
 *  never returned while the next one loads. */
export function useSubagentPresets({ connectionId, profile, request }: SubagentPresetOwner): null | Preset[] {
  const ownerKey = JSON.stringify([connectionId ?? null, profile])
  const [loaded, setLoaded] = useState<{ key: string; presets: Preset[] } | null>(null)

  useEffect(() => {
    let current = true
    void request<SubagentPresetLibrary>('delegation.presets', { profile })
      .then(library => {
        if (current && Array.isArray(library.presets)) {
          setLoaded({ key: ownerKey, presets: library.presets })
        }
      })
      .catch(() => undefined)

    return () => {
      current = false
    }
  }, [ownerKey, profile, request])

  return loaded?.key === ownerKey ? loaded.presets : null
}

/** One selection applies a captured preset to this chat only (or to the draft's first create). */
export function SubagentPresetMenuItems({
  connectionId,
  profile,
  sessionId,
  request,
  presets,
  onClose
}: SubagentPresetOwner & { presets: Preset[]; onClose: () => void }) {
  const { t } = useI18n()
  const copy = t.settings.model.subagents.quick

  // Each item captures the owner it was listed for; the action never reads a later owner.
  async function apply(preset: Preset, owner: SubagentPresetOwner) {
    onClose()

    try {
      if (owner.sessionId) {
        const params = { profile: owner.profile, session_id: owner.sessionId }
        await owner.request('delegation.settings', { ...params, preset_name: preset.name })
        const confirmed = await owner.request<SubagentSettingsResult>('delegation.settings', params)
        cacheSubagentSettings(subagentSessionKey(owner.connectionId, owner.profile, owner.sessionId), confirmed)
      } else {
        setSubagentDraft(owner.connectionId, owner.profile, { override: preset.settings, preset_name: preset.name })
      }
    } catch {
      notify({ kind: 'error', message: copy.failed })
    }
  }

  const owner = { connectionId, profile, request, sessionId }

  return (
    <>
      <div className={dropdownMenuSectionLabel}>{copy.presets}</div>
      {presets.map(preset => (
        <DropdownMenuItem
          className={cn(dropdownMenuRow, 'min-w-0')}
          key={preset.name}
          onSelect={() => void apply(preset, owner)}
        >
          <span className="truncate">{preset.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
