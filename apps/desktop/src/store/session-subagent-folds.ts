import { Codecs, persistentAtom } from '@/lib/persisted'

// connection, profile, compression-lineage root. Only expanded folds need saving.
export const $expandedSessionSubagents = persistentAtom<string[]>(
  'hermes.desktop.expandedSessionSubagents.v1',
  [],
  Codecs.json(value =>
    Array.isArray(value)
      ? value.filter((key): key is string => typeof key === 'string' && decodeKey(key) !== null).slice(-512)
      : []
  )
)

function decodeKey(key: string): [string, string, string] | null {
  try {
    const value: unknown = JSON.parse(key)

    return Array.isArray(value) &&
      value.length === 3 &&
      value.every(part => typeof part === 'string' && part.length > 0)
      ? (value as [string, string, string])
      : null
  } catch {
    return null
  }
}

export function setSessionSubagentsExpanded(key: string, expanded: boolean): void {
  const next = $expandedSessionSubagents.get().filter(saved => saved !== key)

  if (expanded) {
    next.push(key)
  }

  $expandedSessionSubagents.set(next.slice(-512))
}

export function migrateSubagentFoldsForProfile(from: string, to: string): void {
  $expandedSessionSubagents.set([
    ...new Set(
      $expandedSessionSubagents.get().map(key => {
        const scope = decodeKey(key)

        return scope && scope[0] === 'local' && scope[1] === from ? JSON.stringify([scope[0], to, scope[2]]) : key
      })
    )
  ])
}

export function dropSubagentFoldsForProfile(
  profile: string,
  route?: { connectionId?: string; profile?: string; targetProfile?: string }
): void {
  $expandedSessionSubagents.set(
    $expandedSessionSubagents.get().filter(key => {
      const scope = decodeKey(key)

      if (!scope) {
        return false
      }

      const connection = route?.connectionId?.trim() || 'local'
      const target = route?.targetProfile?.trim() || route?.profile?.trim() || profile

      return scope[0] !== connection || scope[1] !== target
    })
  )
}
