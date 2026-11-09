import type { SessionInfo } from '@/types/hermes'

export interface SidebarSessionEntry {
  branchStem?: string
  session: SessionInfo
}

export interface FlattenSessionsOptions {
  /**
   * Keep the input root order instead of re-sorting by group recency.
   * Use for hand-ordered surfaces (pinned ids, manual recents drag) so a
   * turn completing can't float a row. Branch children still nest under
   * their parent; sibling branches stay ordered by their own recency.
   */
  preserveOrder?: boolean
  /** Search may show subagents independently of their folded parents. */
  includeSubagents?: boolean
}

const recency = (session: SessionInfo): number => session.last_active || session.started_at || 0

/**
 * Parent id to nest under, or undefined for a top-level sibling.
 *
 * `/new` and idle/daily rotation keep `parent_session_id` for durable lineage
 * but stamp `_reset_from`. Those are new conversations, not nested forks.
 * Genuine `/branch` writes `_branched_from`. Optimistic desktop branch rows
 * (and legacy forks minted before the marker) only have `parent_session_id`.
 */
export function forkParentId(session: SessionInfo): string | undefined {
  if (session._reset_from?.trim()) {
    return undefined
  }

  const branchedFrom = session._branched_from?.trim()

  if (branchedFrom) {
    return branchedFrom
  }

  return session.parent_session_id?.trim() || undefined
}

// Profile-qualified compression lineage, same key as mergeSessionPage (store/session.ts). The
// backend's `_lineage_root_id` follows compression edges only; /branch and /new children get
// their own root, so rows sharing a key are one conversation, never a fork.
export const sessionTreeKey = (session: SessionInfo, id = session.id): string =>
  JSON.stringify([session.connection_id?.trim() || 'local', session.profile?.trim() || 'default', id])

const lineageKey = (session: SessionInfo): string =>
  sessionTreeKey(session, session._lineage_root_id?.trim() || session.id)

export function isSubagentSession(session: SessionInfo): boolean {
  return (
    session.is_internal_child ??
    (!session._reset_from &&
      !session._branched_from &&
      (session.source === 'subagent' || Boolean(session._delegate_from)))
  )
}

/**
 * One row per compression lineage. A stale tip can outlive its rotation in the store (#82290);
 * keep the row nothing in its lineage continues from, then the freshest by mergeSessionPage's
 * recency rule (first in input on a tie).
 */
function collapseCompressionLineages(sessions: readonly SessionInfo[]): readonly SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>()

  for (const session of sessions) {
    const key = lineageKey(session)
    const group = groups.get(key)

    if (group) {
      group.push(session)
    } else {
      groups.set(key, [session])
    }
  }

  if (groups.size === sessions.length) {
    return sessions
  }

  const winners = new Set<SessionInfo>()

  for (const group of groups.values()) {
    const continuedIds = new Set(group.map(session => session.parent_session_id?.trim()))

    const score = (session: SessionInfo) =>
      continuedIds.has(session.id) ? -Infinity : Math.max(session.last_active || 0, session.started_at || 0)

    winners.add(group.reduce((best, session) => (score(session) > score(best) ? session : best)))
  }

  return sessions.filter(session => winners.has(session))
}

const sessionAliases = (session: SessionInfo) =>
  [session.id, session._lineage_root_id, ...(session._lineage_ids ?? [])]
    .filter((id): id is string => Boolean(id))
    .map(id => sessionTreeKey(session, id))

function visibleBranchSessions(input: readonly SessionInfo[], includeSubagents = false): readonly SessionInfo[] {
  // An opened subagent may remain in the shared cache. Neither it nor its forks
  // may bypass its parent's disclosure (including the one-row fast path).
  const hidden = new Set(input.filter(isSubagentSession).flatMap(sessionAliases))

  if (!includeSubagents) {
    let changed = true

    while (changed) {
      changed = false

      for (const session of input) {
        const parent = forkParentId(session)
        const key = sessionTreeKey(session)

        if (!hidden.has(key) && parent && hidden.has(sessionTreeKey(session, parent))) {
          sessionAliases(session).forEach(alias => hidden.add(alias))
          changed = true
        }
      }
    }
  }

  return includeSubagents ? input : input.filter(session => !hidden.has(sessionTreeKey(session)))
}

/** Flat list with branch/fork sessions nested visually under their parent. */
export function flattenSessionsWithBranches(
  input: readonly SessionInfo[],
  options: FlattenSessionsOptions = {}
): SidebarSessionEntry[] {
  const visible = visibleBranchSessions(input, options.includeSubagents)
  const sessions = collapseCompressionLineages(visible)

  if (sessions.length < 2) {
    return sessions.map(session => ({ session }))
  }

  const byVisibleId = new Map<string, SessionInfo>()

  for (const session of sessions) {
    sessionAliases(session).forEach(alias => byVisibleId.set(alias, session))
  }

  // A collapsed stale tip still names its conversation: its /branch children nest under the survivor.
  const survivorByLineage = new Map(sessions.map(session => [lineageKey(session), session]))

  for (const session of input) {
    const survivor = survivorByLineage.get(lineageKey(session))

    if (survivor && !byVisibleId.has(sessionTreeKey(session))) {
      byVisibleId.set(sessionTreeKey(session), survivor)
    }
  }

  const childrenByParent = new Map<string, SessionInfo[]>()
  const nestedIds = new Set<string>()

  for (const session of sessions) {
    const parentId = forkParentId(session)

    if (!parentId) {
      continue
    }

    const parent = byVisibleId.get(sessionTreeKey(session, parentId))

    // Compression ancestry is not a branch: never nest a row under its own lineage.
    if (!parent || lineageKey(parent) === lineageKey(session)) {
      continue
    }

    nestedIds.add(sessionTreeKey(session))
    const siblings = childrenByParent.get(sessionTreeKey(parent)) ?? []
    siblings.push(session)
    childrenByParent.set(sessionTreeKey(parent), siblings)
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => recency(right) - recency(left))
  }

  // A group sorts by its freshest member, so activity on any branch lifts the
  // whole parent→branches cluster together instead of stranding the parent at
  // its own stale timestamp. Memoized — each subtree is folded at most once.
  // Skipped when preserveOrder is set: the caller already chose positions.
  const groupRecencyMemo = new Map<string, number>()

  const groupRecency = (session: SessionInfo): number => {
    const cached = groupRecencyMemo.get(sessionTreeKey(session))

    if (cached !== undefined) {
      return cached
    }

    groupRecencyMemo.set(sessionTreeKey(session), recency(session)) // cycle guard

    const max = (childrenByParent.get(sessionTreeKey(session)) ?? []).reduce(
      (acc, child) => Math.max(acc, groupRecency(child)),
      recency(session)
    )

    groupRecencyMemo.set(sessionTreeKey(session), max)

    return max
  }

  // Depth-first so a branch-of-a-branch still renders under its own parent. The
  // `seen` set guards against pathological parent cycles, and the trailing sweep
  // emits anything the walk somehow missed — nothing past the lineage collapse is dropped.
  const out: SidebarSessionEntry[] = []
  const seen = new Set<string>()

  const emit = (session: SessionInfo, branchStem?: string, prefix = '') => {
    if (seen.has(sessionTreeKey(session))) {
      return
    }

    seen.add(sessionTreeKey(session))
    out.push(branchStem ? { branchStem, session } : { session })

    const children = childrenByParent.get(sessionTreeKey(session))
    children?.forEach((child, index) => {
      const last = index === children.length - 1
      emit(child, prefix + (last ? '└─ ' : '├─ '), prefix + (last ? '   ' : '│  '))
    })
  }

  const roots = sessions
    .filter(session => !nestedIds.has(sessionTreeKey(session)))
    .map((session, index) => ({ index, session }))

  if (!options.preserveOrder) {
    roots.sort((a, b) => groupRecency(b.session) - groupRecency(a.session) || a.index - b.index)
  }

  roots.forEach(({ session }) => emit(session))

  for (const session of sessions) {
    if (!seen.has(sessionTreeKey(session))) {
      out.push({ session })
    }
  }

  return out
}
