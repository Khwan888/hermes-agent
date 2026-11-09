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

function SessionSubagentChildren({ actions, ancestors, depth, owner }: SessionSubagentChildrenProps) {
  const { t } = useI18n()
  const h = t.sidebar.subagents
  const [page, setPage] = useState<SessionSubagentsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const offset = useRef(0)
  const busy = useRef(false)
  const scope = { connectionId: owner.connection_id, profile: owner.profile || 'default' }

  // A second request while one is in flight is coalesced: a pending first-page refresh runs after it.
  const refreshPending = useRef(false)

  // `more` reads the next page; `refresh` re-reads the first page (new children sort first) and
  // keeps every page already loaded, so focus and scroll stay put.
  const load = async (mode: 'more' | 'refresh' = 'more') => {
    if (busy.current) {
      refreshPending.current ||= mode === 'refresh'

      return
    }

    busy.current = true

    if (mode === 'more') {
      setLoading(true)
    }

    setFailed(false)

    try {
      const next = await listSessionSubagents(owner.id, scope, {
        limit: 50,
        offset: mode === 'refresh' ? 0 : offset.current
      })

      if (!mounted.current) {
        return
      }

      offset.current = Math.max(offset.current, next.offset + next.sessions.length)
      setPage(previous => {
        const ordered =
          mode === 'refresh'
            ? [...next.sessions, ...(previous?.sessions ?? [])]
            : [...(previous?.sessions ?? []), ...next.sessions]

        // First position wins (new children on top, loaded rows in place); the fresh reply's row wins.
        const fresh = new Map(next.sessions.map(session => [sessionTreeKey(session), session]))
        const sessions = new Map<string, SessionInfo>()

        for (const session of ordered) {
          const key = sessionTreeKey(session)

          if (!sessions.has(key)) {
            sessions.set(key, fresh.get(key) ?? session)
          }
        }

        const rows = [...sessions.values()]

        return { ...next, sessions: rows, has_more: rows.length < next.total }
      })
    } catch {
      if (mounted.current && mode === 'more') {
        setFailed(true)
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
          key={sessionTreeKey(session)}
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
          <Button onClick={() => void load()} size="inline" variant="text">
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
