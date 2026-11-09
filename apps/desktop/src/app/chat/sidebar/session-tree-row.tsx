import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { ambientOwnerConnectionId } from '@/api/client'
import { listSessionSubagents, type SessionSubagentsPage } from '@/api/sessions'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { sessionTreeKey } from '@/lib/session-branch-tree'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $connection, sessionPinId } from '@/store/session'
import { $expandedSessionSubagents, setSessionSubagentsExpanded } from '@/store/session-subagent-folds'
import type { SessionInfo } from '@/types/hermes'

import { SidebarSessionRow, type SidebarSessionRowProps } from './session-row'

export interface SessionTreeActions {
  activeSessionId: null | string
  onArchiveSession: (id: string) => void
  onBranchSession?: (id: string, profile?: string) => void
  onDeleteSession: (id: string) => void
  onResumeSession: (id: string, session?: SessionInfo) => void
  onTogglePin: (id: string) => void
  onToggleUnread: (id: string) => void
}

interface SessionTreeRowProps extends SidebarSessionRowProps {
  actions: SessionTreeActions
  subagentDepth?: number
  ancestors?: string[]
}

/** No-subagent rows keep the exact existing row: no disclosure, wrapper or fetch. */
export function SidebarSessionTreeRow(props: SessionTreeRowProps) {
  const { actions: _actions, subagentDepth: _depth, ancestors: _ancestors, ...row } = props
  const connection = useStore($connection)
  const owner = { ...row.session, connection_id: row.session.connection_id || ambientOwnerConnectionId() }

  // Legacy direct remotes have no registry pin. Separate their saved folds by
  // URL, but never send that synthetic identity as a request connection id.
  const connectionKey =
    owner.connection_id ||
    connection?.connectionId ||
    (connection?.mode === 'remote' ? `url:${connection.baseUrl || 'remote'}` : 'local')

  const key = sessionTreeKey({ ...owner, connection_id: connectionKey }, owner._lineage_root_id || owner.id)

  return (row.session.subagent_count ?? 0) > 0 && !props.ancestors?.includes(key) ? (
    <SessionWithSubagents {...props} foldKey={key} key={`${key}:${row.session.id}`} owner={owner} />
  ) : (
    <SidebarSessionRow {...row} />
  )
}

interface SessionWithSubagentsProps extends SessionTreeRowProps {
  foldKey: string
  owner: SessionInfo
}

function SessionWithSubagents({
  foldKey,
  owner,
  actions,
  subagentDepth = 0,
  ancestors = [],
  ...row
}: SessionWithSubagentsProps) {
  const { t } = useI18n()
  const open = useStoreSelector($expandedSessionSubagents, keys => keys.includes(foldKey))

  // Compact on purpose: the title lane keeps its width at the normal sidebar size and in long
  // locales. The visible number is the direct-child count; the full phrase is the accessible
  // name and the tip, so meaning never rests on the number alone.
  const countLabel = t.sidebar.subagents.count(owner.subagent_count!)

  const control = (
    <Tip label={countLabel}>
      <Button
        aria-expanded={open}
        aria-label={countLabel}
        className="tabular-nums"
        data-subagent-count={owner.subagent_count}
        onClick={() => setSessionSubagentsExpanded(foldKey, !open)}
        size="inline"
        variant="text"
      >
        <DisclosureCaret open={open} />
        {owner.subagent_count}
      </Button>
    </Tip>
  )

  return (
    <>
      <SidebarSessionRow {...row} subagentControl={control} />
      {open && (
        <SessionSubagentChildren
          actions={actions}
          ancestors={[...ancestors, foldKey]}
          depth={subagentDepth + 1}
          owner={owner}
        />
      )}
    </>
  )
}

interface SessionSubagentChildrenProps {
  actions: SessionTreeActions
  ancestors: string[]
  depth: number
  owner: SessionInfo
}

// One row per child lineage: a rotated (compressed) child's new tip replaces its old row in place.
const childKey = (session: SessionInfo) => sessionTreeKey(session, session._lineage_root_id || session.id)

interface LoadedChildren {
  sessions: SessionInfo[]
  /** Server rows the loaded window covers; the next page starts here. Stale rows never count. */
  loaded: number
  has_more: boolean
}

/** Append a later page; a lineage already loaded keeps its position and takes the fresh row. */
function appendPage(previous: LoadedChildren | null, next: SessionSubagentsPage): LoadedChildren {
  const fresh = new Map(next.sessions.map(session => [childKey(session), session]))
  const kept = (previous?.sessions ?? []).map(session => fresh.get(childKey(session)) ?? session)
  const seen = new Set(kept.map(childKey))
  const loaded = next.offset + next.sessions.length

  return {
    sessions: [...kept, ...next.sessions.filter(session => !seen.has(childKey(session)))],
    loaded,
    has_more: loaded < next.total
  }
}

/**
 * Reconcile a re-read first page: it is authoritative for the range it covers, so a deleted child
 * leaves and a rotated one is replaced. Rows loaded past that range (later pages) are kept in place;
 * they follow the last row both reads share, and paging continues after them.
 */
function refreshPage(previous: LoadedChildren | null, next: SessionSubagentsPage): LoadedChildren {
  const fresh = new Set(next.sessions.map(childKey))
  const old = previous?.sessions ?? []
  const complete = next.sessions.length >= next.total
  const lastShared = old.findLastIndex(session => fresh.has(childKey(session)))

  const tail =
    complete || lastShared < 0 ? [] : old.slice(lastShared + 1).filter(session => !fresh.has(childKey(session)))

  const loaded = next.sessions.length + tail.length

  return { sessions: [...next.sessions, ...tail], loaded, has_more: loaded < next.total }
}

type ChildrenLoad = 'more' | 'refresh'

function SessionSubagentChildren({ actions, ancestors, depth, owner }: SessionSubagentChildrenProps) {
  const { t } = useI18n()
  const h = t.sidebar.subagents
  const [page, setPage] = useState<LoadedChildren | null>(null)
  const [loading, setLoading] = useState(true)
  // Which read failed, so Retry repeats it: a failed refresh re-reads the first page, not the next one.
  const [failed, setFailed] = useState<ChildrenLoad | null>(null)
  const mounted = useRef(false)
  // Reads reconcile against the latest window, not a render-time snapshot.
  const pageRef = useRef<LoadedChildren | null>(null)
  const offset = useRef(0)
  const busy = useRef(false)
  const scope = { connectionId: owner.connection_id, profile: owner.profile || 'default' }

  // A second request while one is in flight is coalesced: a pending first-page refresh runs after it.
  const refreshPending = useRef(false)

  // `more` reads the next page; `refresh` re-reads the first page (new children sort first) over the
  // loaded window and reconciles it, so loaded rows keep their place, focus and scroll.
  const load = async (mode: ChildrenLoad = 'more') => {
    if (busy.current) {
      refreshPending.current ||= mode === 'refresh'

      return
    }

    busy.current = true

    if (mode === 'more') {
      setLoading(true)
    }

    setFailed(null)

    try {
      const next = await listSessionSubagents(owner.id, scope, {
        // A refresh covers the loaded window when it fits the endpoint's page cap.
        limit: mode === 'refresh' ? Math.min(100, Math.max(50, offset.current)) : 50,
        offset: mode === 'refresh' ? 0 : offset.current
      })

      if (!mounted.current) {
        return
      }

      const reconcile = mode === 'refresh' ? refreshPage : appendPage
      const result = reconcile(pageRef.current, next)
      pageRef.current = result
      offset.current = result.loaded
      setPage(result)
    } catch {
      // Loaded rows stay (stale) with an inline Retry; nothing retries on its own.
      if (mounted.current) {
        setFailed(mode)
      }
    } finally {
      busy.current = false

      if (mounted.current) {
        setLoading(false)

        if (refreshPending.current) {
          refreshPending.current = false
          void load('refresh')
        }
      }
    }
  }

  // Mount lifetime fences late network replies; this is not a reactive store mirror.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    mounted.current = true
    void load()

    return () => {
      mounted.current = false
    }
    // This content is keyed by its captured owner and unmounts when folded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The owner's child count moves when a list refresh sees a new (or removed) child. Re-read the
  // first page of an already open subtree then — never polled, and folded rows fetch nothing.
  const childCount = owner.subagent_count ?? 0
  const [seenCount, setSeenCount] = useState(childCount)
  const [refreshes, setRefreshes] = useState(0)

  // Adjust-state-during-render: compare against the last count this subtree saw.
  if (seenCount !== childCount) {
    setSeenCount(childCount)
    setRefreshes(value => value + 1)
  }

  useEffect(() => {
    if (refreshes > 0) {
      void load('refresh')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshes])

  return (
    <div className="pl-3.5" data-subagent-children={owner.id}>
      {page?.sessions.map((session, index) => (
        <SidebarSessionTreeRow
          actions={actions}
          ancestors={ancestors}
          branchStem={index === page.sessions.length - 1 && !page.has_more ? '└─ ' : '├─ '}
          data-parent-session-id={owner.id}
          data-subagent-depth={depth}
          isPinned={Boolean(session.pinned)}
          isSelected={actions.activeSessionId === session.id}
          key={childKey(session)}
          onArchive={() => actions.onArchiveSession(session.id)}
          onBranch={actions.onBranchSession ? () => actions.onBranchSession?.(session.id, session.profile) : undefined}
          onDelete={() => actions.onDeleteSession(session.id)}
          onPin={() => actions.onTogglePin(sessionPinId(session))}
          onResume={() => actions.onResumeSession(session.id, session)}
          onToggleUnread={() => actions.onToggleUnread(session.id)}
          session={session}
          subagentDepth={depth}
          unread={session.unread === true}
        />
      ))}
      {loading && (
        <span className="text-xs text-(--ui-text-tertiary)" role="status">
          {h.loading}
        </span>
      )}
      {failed && (
        <div className="text-xs text-(--ui-text-tertiary)" role="status">
          {h.loadFailed}{' '}
          <Button onClick={() => void load(failed)} size="inline" variant="text">
            {h.retry}
          </Button>
        </div>
      )}
      {!loading && !failed && page?.has_more && (
        <Button onClick={() => void load()} size="inline" variant="text">
          {h.loadMore}
        </Button>
      )}
      {!loading && !failed && page?.sessions.length === 0 && (
        <span className="text-xs text-(--ui-text-tertiary)">{h.empty}</span>
      )}
    </div>
  )
}
