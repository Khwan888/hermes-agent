import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback, useContext, useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { ModelMenuCloseContext } from '@/app/shell/model-catalog-menu'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenuItem,
  dropdownMenuRow,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import { cn } from '@/lib/utils'
import {
  $activeGatewayRoute,
  activeGatewayConnectionId,
  gatewayRouteState,
  requestGatewayForAgent
} from '@/store/gateway'

import { useComposerScope } from './scope'
import { SubagentPresetMenuItems, useSubagentPresets } from './subagent-preset-menu'
import {
  $subagentDrafts,
  $subagentSettings,
  cacheSubagentSettings,
  subagentOwnerKey,
  type SubagentRequester,
  subagentSessionKey,
  subagentSettingsDiffer,
  type SubagentSettingsResult
} from './subagent-settings-data'
import { SubagentSettingsDialog } from './subagent-settings-dialog'

/** The pill's owner: the composer's connection + profile, and the chat it shows (none for a draft). */
export function useSubagentSettingsOwner() {
  const scope = useComposerScope()
  const activeProfile = useStore($activeGatewayRoute)
  const view = useSessionView()
  const sessionId = useStore(view.$runtimeId)
  const profile = scope.profile || activeProfile || 'default'
  const connectionId = scope.connectionId ?? activeGatewayConnectionId()

  const request = useCallback<SubagentRequester>(
    (method, params) => requestGatewayForAgent(connectionId ?? null, profile, method, { ...params, profile }),
    [connectionId, profile]
  )

  return { connectionId, profile, sessionId, request }
}

/** One small marker in the model pill, only while this chat's (or this draft's) subagent settings differ
 *  from the profile's. An untouched chat renders nothing, so its pill is unchanged. */
export function SubagentSettingsMarker() {
  const owner = useSubagentSettingsOwner()
  const { t } = useI18n()
  const copy = t.settings.model.subagents.quick
  const values = useStore($subagentSettings)
  const drafts = useStore($subagentDrafts)
  const { connectionId, profile, sessionId, request } = owner
  const key = subagentSessionKey(connectionId, profile, sessionId)

  useEffect(() => {
    if (!sessionId || !gatewayRouteState(connectionId ?? null, profile).open) {
      return
    }

    let current = true
    void request<SubagentSettingsResult>('delegation.settings', { session_id: sessionId })
      .then(result => {
        if (current) {
          cacheSubagentSettings(key, result)
        }
      })
      .catch(() => {
        /* Older backends have no per-chat subagent settings: no marker. */
      })

    return () => {
      current = false
    }
  }, [key, sessionId, profile, connectionId, request])

  const baseline = values[key]
  const draft = sessionId ? undefined : drafts[subagentOwnerKey(connectionId, profile)]

  const differs = sessionId
    ? baseline && subagentSettingsDiffer(baseline.effective, baseline.defaults)
    : draft?.override &&
      (!baseline || subagentSettingsDiffer({ ...baseline.defaults, ...draft.override }, baseline.defaults))

  if (!differs) {
    return null
  }

  const presetName = sessionId ? baseline?.preset_name : draft?.preset_name
  const label = presetName ? `${copy.presets}: ${presetName}` : copy.marker

  return (
    <span
      aria-label={label}
      className="flex max-w-24 shrink-0 items-center gap-0.5 text-(--ui-accent)"
      data-testid="subagent-settings-marker"
      role="img"
    >
      <Codicon name="organization" size="0.7rem" />
      {presetName && <span className="truncate">{presetName}</span>}
    </span>
  )
}

interface SubagentSettingsIntent {
  connectionId?: string | null
  profile: string
  sessionId?: string | null
  request: SubagentRequester
}

const $subagentSettingsDialog = atom<SubagentSettingsIntent | null>(null)

/** Lives beside the model dropdown, not inside its unmounting content. */
export function SubagentSettingsDialogHost() {
  const owner = useSubagentSettingsOwner()
  const intent = useStore($subagentSettingsDialog)

  if (
    !intent ||
    subagentSessionKey(intent.connectionId, intent.profile, intent.sessionId) !==
      subagentSessionKey(owner.connectionId, owner.profile, owner.sessionId)
  ) {
    return null
  }

  return <SubagentSettingsDialog {...intent} onClose={() => $subagentSettingsDialog.set(null)} />
}

/** The model menu's footer row. With saved presets it opens a small submenu (edit + presets), so a long
 *  library never floods the model list; without presets it opens the editor directly. */
export function SubagentSettingsMenuRow(props: SubagentSettingsIntent) {
  const { t } = useI18n()
  const copy = t.settings.model.subagents.quick
  const close = useContext(ModelMenuCloseContext)
  const supported = useSubagentSettingsSupported(props)
  const presets = useSubagentPresets(props)

  // An older backend has no per-chat subagent settings: offer nothing rather than a row that can
  // only fail. Transient failures keep the row; the editor reports them itself.
  if (!supported) {
    return null
  }

  // Same footer row treatment as Refresh / Add custom model / Edit models beside it.
  const rowClass = cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')
  const icon = <Codicon name="organization" size="0.75rem" />

  const openEditor = () => {
    close()
    $subagentSettingsDialog.set(props)
  }

  if (!presets?.length) {
    return (
      <DropdownMenuItem className={rowClass} onSelect={openEditor}>
        {icon}
        {copy.custom}
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={rowClass}>
        {icon}
        {copy.custom}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56 p-0" sideOffset={4}>
        <DropdownMenuItem className={rowClass} onSelect={openEditor}>
          <Codicon name="edit" size="0.75rem" />
          {copy.edit}
        </DropdownMenuItem>
        <SubagentPresetMenuItems {...props} onClose={close} presets={presets} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** One read per menu open, per owner: only a method-not-found answer hides the entry. */
function useSubagentSettingsSupported({ connectionId, profile, request, sessionId }: SubagentSettingsIntent) {
  const owner = JSON.stringify([connectionId ?? null, profile])
  const [missing, setMissing] = useState<null | string>(null)

  useEffect(() => {
    let current = true
    void request('delegation.settings', { profile, ...(sessionId ? { session_id: sessionId } : {}) }).then(
      () => current && setMissing(value => (value === owner ? null : value)),
      error => current && isMissingRpcMethod(error) && setMissing(owner)
    )

    return () => {
      current = false
    }
  }, [owner, profile, request, sessionId])

  return missing !== owner
}
