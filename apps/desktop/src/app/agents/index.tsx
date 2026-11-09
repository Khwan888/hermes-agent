import { compactNumber } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'

import { ambientOwnerConnectionId } from '@/api/client'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { FadeText } from '@/components/ui/fade-text'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { type Translations, useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { subagentRouteSubtitle } from '@/lib/subagent-route'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $activeSessionId, $selectedStoredSessionId, $sessions, sessionMatchesStoredId, setSessionOwnerHint } from '@/store/session'
import { knownOwnerForSession } from '@/store/session-states'
import {
  $finishedSubagentsBySession,
  $subagentsBySession,
  buildSubagentTree,
  type SubagentNode,
  subagentsForPanel,
  type SubagentStatus,
  type SubagentStreamEntry
} from '@/store/subagents'

import { openSubagent } from '../open-subagent'
import { Panel, PanelEmpty, PanelHeader } from '../overlays/panel'

import { mergeStoredSubagents, useStoredSubagents } from './use-stored-subagents'

// Mirrors statusGlyph() in tool-fallback.tsx so subagent rows speak the
// same visual vocabulary as the chat tool blocks.
function statusGlyph(status: SubagentStatus, a: Translations['agents']): ReactNode {
  if (status === 'running' || status === 'queued') {
    return (
      <GlyphSpinner
        ariaLabel={a.running}
        className="size-3.5 shrink-0 text-[0.95rem] text-muted-foreground/80"
        spinner="breathe"
      />
    )
  }

  if (status === 'failed' || status === 'interrupted') {
    return <AlertCircle aria-label={a.failed} className="size-3.5 shrink-0 text-destructive" />
  }

  return <CheckCircle2 aria-label={a.done} className="size-3.5 shrink-0 text-emerald-600/85 dark:text-emerald-400/85" />
}

const STREAM_TONE: Record<SubagentStreamEntry['kind'], string> = {
  progress: 'text-muted-foreground/75',
  summary: 'text-foreground/85',
  thinking: 'text-muted-foreground/80',
  tool: 'text-foreground/85'
}

function streamGlyph(entry: SubagentStreamEntry): ReactNode {
  // Errors carry no glyph of their own: the row's status icon already marks
  // the failure, and the destructive text says what went wrong.
  if (entry.isError) {
    return null
  }

  if (entry.kind === 'tool') {
    return <span aria-hidden className="mt-0.5 size-1.5 shrink-0 rounded-full bg-foreground/55" />
  }

  if (entry.kind === 'summary') {
    return <CheckCircle2 aria-hidden className="mt-0.5 size-3 shrink-0 text-emerald-600/85 dark:text-emerald-400/85" />
  }

  if (entry.kind === 'thinking') {
    return (
      <span aria-hidden className="font-mono text-[0.7rem] leading-none text-muted-foreground/70">
        …
      </span>
    )
  }

  return <span aria-hidden className="mt-0.5 size-1 shrink-0 rounded-full bg-muted-foreground/55" />
}

interface AgentsViewProps {
  onClose: () => void
}

export function AgentsView({ onClose }: AgentsViewProps) {
  const { t } = useI18n()
  const subagentsBySession = useStore($subagentsBySession)
  const finishedBySession = useStore($finishedSubagentsBySession)
  const activeSessionId = useStore($activeSessionId)
  const storedSessionId = useStore($selectedStoredSessionId) || activeSessionId
  const sessions = useStore($sessions)
  const ownerRow = sessions.find(session => storedSessionId && sessionMatchesStoredId(session, storedSessionId))
  const history = useStoredSubagents(storedSessionId, ownerRow)
  const stored = history.rows

  // Aggregate every session for live work, terminal rows only for the
  // session the user is in — matching the status-bar indicator, so a subagent
  // running in a background session stays visible (the two can never desync,
  // "Agents N running" vs an empty tree) while finished history from inactive
  // sessions no longer accumulates forever (#75505).
  // This session's subagents from earlier turns stay listed (and openable) after
  // the live list moves on to the next turn.
  const tree = useMemo(
    () => buildSubagentTree(mergeStoredSubagents(subagentsForPanel(subagentsBySession, activeSessionId, finishedBySession), stored)),
    [subagentsBySession, activeSessionId, finishedBySession, stored]
  )

  // A finished subagent opens as a tab beside its parent, so leave the panel to
  // show it; a running one opens in its own watch window and the panel stays.
  const onOpen = (node: SubagentNode) => {
    if (!node.sessionId) {
      return
    }

    // Stored rows are not in the sidebar list. Pin the proven owner before the
    // ordinary open path resolves the child's session or clears its unread flag.
    if (stored.some(item => item.session.id === node.sessionId)) {
      const owner = knownOwnerForSession(storedSessionId)

      const connectionId = ownerRow?.connection_id || ambientOwnerConnectionId()
      const profile = typeof owner === 'string' ? owner : ownerRow?.profile || 'default'

      const route = typeof owner === 'object' ? owner : connectionId && (owner || ownerRow)
        ? { connectionId, profile }
        : undefined

      if (route) {
        setSessionOwnerHint(node.sessionId, route)

        if (node.parentSessionId && node.parentSessionId !== storedSessionId) {setSessionOwnerHint(node.parentSessionId, route)}
      }
    }

    const running = node.status === 'running' || node.status === 'queued'
    openSubagent({ running, sessionId: node.sessionId }, { parentSessionId: node.parentSessionId })

    if (!running) {
      onClose()
    }
  }

  // Durable history is read on demand: loading, a failed read and a truly empty chat look different,
  // without adding a layout. An older backend (no history route) just shows live subagents.
  const retry = (
    <Button onClick={history.retry} size="xs" variant="text">
      {t.common.retry}
    </Button>
  )

  return (
    <Panel closeLabel={t.agents.close} onClose={onClose}>
      {tree.length === 0 ? (
        history.status === 'loading' ? (
          <PanelEmpty icon="hubot" title={t.agents.historyLoading} />
        ) : history.status === 'failed' ? (
          <PanelEmpty action={retry} description={t.agents.historyFailedDesc} icon="hubot" title={t.agents.historyFailed} />
        ) : (
          <PanelEmpty description={t.agents.emptyDesc} icon="hubot" title={t.agents.emptyTitle} />
        )
      ) : (
        <>
          <PanelHeader subtitle={t.agents.subtitle} title={t.agents.title} />
          {history.status === 'failed' ? (
            <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" data-subagent-history="failed" role="status">
              {t.agents.historyFailed}
              {retry}
            </p>
          ) : null}
          <SubagentTree onOpen={onOpen} tree={tree} />
        </>
      )}
    </Panel>
  )
}

const fmtDuration = (seconds: number | undefined, a: Translations['agents']) => {
  if (!seconds || seconds <= 0) {
    return ''
  }

  if (seconds < 60) {
    return a.durationSeconds(seconds.toFixed(1))
  }

  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)

  return a.durationMinutes(m, s)
}

const fmtTokens = (value: number | undefined, a: Translations['agents']) =>
  value ? a.tokens(compactNumber(value)) : ''

// Distinct contract from coarseElapsed: rounds to the second (this ticks live),
// and hours are unbounded ("25h", never "1d"). Kept local on purpose.
const fmtAge = (updatedAt: number, nowMs: number, a: Translations['agents']) => {
  const s = Math.max(0, Math.round((nowMs - updatedAt) / 1000))

  if (s < 2) {
    return a.ageNow
  }

  if (s < 60) {
    return a.ageSeconds(s)
  }

  const m = Math.floor(s / 60)

  return m < 60 ? a.ageMinutes(m) : a.ageHours(Math.floor(m / 60))
}

const flatten = (nodes: readonly SubagentNode[]): SubagentNode[] =>
  nodes.flatMap(node => [node, ...flatten(node.children)])

interface RootGroup {
  id: string
  delegationIndex: number
  nodes: SubagentNode[]
  taskCount: number
}

function groupDelegations(roots: readonly SubagentNode[]): RootGroup[] {
  const groups: RootGroup[] = []
  let n = 0

  for (const node of roots) {
    // Exact grouping when the backend tags workers with their batch id —
    // concurrent or nested fan-outs of the same shape must not merge.
    if (node.delegationId) {
      const byId = groups.find(g => g.id === `delegation:${node.delegationId}`)

      if (byId) {
        byId.nodes.push(node)

        continue
      }

      n += 1
      groups.push({
        id: `delegation:${node.delegationId}`,
        delegationIndex: n,
        nodes: [node],
        taskCount: node.taskCount
      })

      continue
    }

    // Older backends (no delegation_id): heuristic grouping by shape + time.
    const prev = groups.at(-1)
    const prevTail = prev?.nodes.at(-1)
    const closeInTime = prevTail ? Math.abs(node.startedAt - prevTail.startedAt) <= 5_000 : false

    const sameShape =
      prev && !prev.id.startsWith('delegation:') && node.taskCount > 1 && prev.taskCount === node.taskCount

    const uniqueStep = prev ? !prev.nodes.some(item => item.taskIndex === node.taskIndex) : false

    if (prev && sameShape && closeInTime && uniqueStep) {
      prev.nodes.push(node)

      continue
    }

    if (node.taskCount > 1) {
      n += 1
      groups.push({ id: `delegation-${n}`, delegationIndex: n, nodes: [node], taskCount: node.taskCount })

      continue
    }

    groups.push({ id: node.id, delegationIndex: 0, nodes: [node], taskCount: node.taskCount })
  }

  return groups
}

function SubagentTree({ onOpen, tree }: { onOpen?: (node: SubagentNode) => void; tree: SubagentNode[] }) {
  const { t } = useI18n()
  const flat = useMemo(() => flatten(tree), [tree])
  const groups = useMemo(() => groupDelegations(tree), [tree])
  const [nowMs, setNowMs] = useState(() => Date.now())

  const active = flat.filter(n => n.status === 'running' || n.status === 'queued').length
  const failed = flat.filter(n => n.status === 'failed' || n.status === 'interrupted').length
  const tools = flat.reduce((sum, n) => sum + (n.toolCount ?? 0), 0)
  const files = flat.reduce((sum, n) => sum + n.filesRead.length + n.filesWritten.length, 0)
  const tokens = flat.reduce((sum, n) => sum + (n.inputTokens ?? 0) + (n.outputTokens ?? 0), 0)
  const cost = flat.reduce((sum, n) => sum + (n.costUsd ?? 0), 0)

  const visible = usePaneVisible()

  useEffect(() => {
    if (active <= 0 || !visible || typeof window === 'undefined') {
      return
    }

    const id = window.setInterval(() => setNowMs(Date.now()), 500)

    return () => window.clearInterval(id)
  }, [active, visible])

  if (tree.length === 0) {
    return (
      <div className="grid place-items-center gap-3 py-12 text-center">
        <Codicon className="text-muted-foreground/60" name="hubot" size="1.5rem" />
        <p className="text-sm font-medium text-foreground/90">{t.agents.emptyTitle}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground/75">{t.agents.emptyDesc}</p>
      </div>
    )
  }

  const failedLabel = failed > 0 ? t.agents.failedCount(failed) : ''

  const summary = [
    t.agents.agentsCount(flat.length),
    active > 0 ? t.agents.activeCount(active) : '',
    failedLabel,
    tools > 0 ? t.agents.toolsCount(tools) : '',
    files > 0 ? t.agents.filesCount(files) : '',
    tokens > 0 ? fmtTokens(tokens, t.agents) : '',
    cost > 0 ? `$${cost.toFixed(2)}` : ''
  ].filter(Boolean)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      <p className="shrink-0 text-[0.7rem] text-muted-foreground/70">
        {summary.map((part, index) => (
          <Fragment key={part}>
            {index > 0 ? ' · ' : null}
            {part === failedLabel ? <span className="text-destructive">{part}</span> : part}
          </Fragment>
        ))}
      </p>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map(group => (
            <DelegationGroup group={group} key={group.id} nowMs={nowMs} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DelegationGroup({
  group,
  nowMs,
  onOpen
}: {
  group: RootGroup
  nowMs: number
  onOpen?: (node: SubagentNode) => void
}) {
  const { t } = useI18n()

  if (group.nodes.length === 1 && group.taskCount <= 1) {
    return <SubagentRow node={group.nodes[0]!} nowMs={nowMs} onOpen={onOpen} />
  }

  const activeWorkers = group.nodes.filter(n => n.status === 'running' || n.status === 'queued').length

  return (
    <section className="grid min-w-0 gap-3">
      <p className="text-[0.66rem] font-medium uppercase tracking-wider text-muted-foreground/70">
        {group.delegationIndex > 0 ? t.agents.delegation(group.delegationIndex) : ''}{' '}
        <span className="text-muted-foreground/50">·</span> {t.agents.workers(group.nodes.length)}
        {activeWorkers > 0 ? <span className="text-primary/85"> · {t.agents.workersActive(activeWorkers)}</span> : null}
      </p>
      <div className="grid min-w-0 gap-4">
        {group.nodes.map(node => (
          <SubagentRow key={node.id} node={node} nowMs={nowMs} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}

function StreamLine({
  active,
  entry,
  parentRunning,
  rowKey
}: {
  active: boolean
  entry: SubagentStreamEntry
  parentRunning: boolean
  rowKey: string
}) {
  const { t } = useI18n()
  const enterRef = useEnterAnimation(parentRunning, `subagent-stream:${rowKey}`)
  const isMono = entry.kind === 'tool'
  const tone = entry.isError ? 'text-destructive' : STREAM_TONE[entry.kind]
  const glyph = streamGlyph(entry)

  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[0.72rem] leading-relaxed" ref={enterRef}>
      {glyph ? <span className="flex h-[0.95rem] shrink-0 items-center">{glyph}</span> : null}
      <span className={cn('min-w-0 flex-1 wrap-anywhere', tone, isMono && 'font-mono text-[0.69rem]')}>
        {entry.text}
        {active ? (
          <GlyphSpinner
            ariaLabel={t.agents.streaming}
            className="ml-1 inline-block size-2.5 align-middle text-muted-foreground/70"
            spinner="breathe"
          />
        ) : null}
      </span>
    </div>
  )
}

/** Beside the row's own toggle, not inside it: one control per button. */
function SubagentOpen({ node, onOpen }: { node: SubagentNode; onOpen?: (node: SubagentNode) => void }) {
  const { t } = useI18n()

  if (!onOpen || !node.sessionId) {
    return null
  }

  return (
    <Button
      aria-label={t.agents.openSubagentTitle}
      className="absolute top-0.5 right-0"
      data-subagent-open=""
      onClick={() => onOpen(node)}
      size="micro"
      type="button"
      variant="text"
    >
      {t.agents.openSubagent}
    </Button>
  )
}

export function SubagentRow({
  node,
  depth = 0,
  nowMs,
  onOpen,
  parentSessionId
}: {
  node: SubagentNode
  depth?: number
  nowMs: number
  /** Agents tab only: open the subagent's own page (absent in the status stack). */
  onOpen?: (node: SubagentNode) => void
  parentSessionId?: string
}) {
  const { t } = useI18n()
  const running = node.status === 'running' || node.status === 'queued'
  const elapsed = useElapsedSeconds(running, `subagent:${node.id}`, node.startedAt)

  const durationSeconds =
    typeof node.durationSeconds === 'number' ? Math.max(0, Math.round(node.durationSeconds)) : elapsed

  const [open, setOpen] = useState(() => running || depth < 2)
  const enterRef = useEnterAnimation(true, `subagent-row:${node.id}`)

  useEffect(() => {
    if (running) {
      setOpen(true)
    }
  }, [running])

  const visibleRows = open ? node.stream.slice(-10) : node.stream.slice(-2)
  const fileLines = [...node.filesWritten.map(p => `+ ${p}`), ...node.filesRead.map(p => `· ${p}`)]

  const subtitle = [
    ...subagentRouteSubtitle(node.route, node.model, t.agents),
    fmtDuration(durationSeconds, t.agents),
    node.toolCount ? t.agents.toolsCount(node.toolCount) : '',
    fmtTokens((node.inputTokens ?? 0) + (node.outputTokens ?? 0), t.agents),
    t.agents.updatedAgo(fmtAge(node.updatedAt, nowMs, t.agents))
  ].filter(Boolean)

  return (
    <div
      className={cn('relative grid min-w-0 max-w-full gap-2', depth > 0 && 'pl-4')}
      data-parent-session-id={parentSessionId ?? node.parentSessionId}
      data-session-id={node.sessionId}
      data-slot="tool-block"
      data-subagent-id={node.id}
      data-subagent-status={node.status}
      ref={enterRef}
    >
      <button
        aria-expanded={open}
        className={cn('group flex w-full min-w-0 items-start gap-2.5 text-left', onOpen && node.sessionId && 'pr-12')}
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <span className="mt-0.5 flex h-[1.1rem] shrink-0 items-center">{statusGlyph(node.status, t.agents)}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'wrap-anywhere text-[0.82rem] font-medium leading-[1.1rem] text-foreground/90 transition-colors group-hover:text-foreground',
              running && 'shimmer text-foreground/65'
            )}
          >
            {node.goal}
          </span>
          {subtitle.length > 0 ? (
            <FadeText className="text-[0.66rem] leading-[1.05rem] text-muted-foreground" title={subtitle.join(' · ')}>
              {subtitle.join(' · ')}
            </FadeText>
          ) : null}
        </span>
        {running ? <ActivityTimerText className="mt-1 shrink-0 text-[0.6rem]" seconds={durationSeconds} /> : null}
      </button>
      <SubagentOpen node={node} onOpen={onOpen} />

      {visibleRows.length > 0 ? (
        <div className="grid min-w-0 gap-1 pl-6" data-selectable-text="true">
          {visibleRows.map((entry, i) => (
            <StreamLine
              active={running && i === visibleRows.length - 1}
              entry={entry}
              key={`${entry.kind}:${entry.at}:${i}`}
              parentRunning={running}
              rowKey={`${node.id}:${entry.kind}:${entry.at}`}
            />
          ))}
        </div>
      ) : null}

      {open && fileLines.length > 0 ? (
        <div className="grid min-w-0 gap-0.5 pl-6" data-selectable-text="true">
          <p className="text-[0.58rem] font-medium tracking-wider text-muted-foreground/60 uppercase">
            {t.agents.files}
          </p>
          {fileLines.slice(0, 8).map(line => (
            <p className="wrap-break-word font-mono text-[0.67rem] leading-relaxed text-muted-foreground/80" key={line}>
              {line}
            </p>
          ))}
          {fileLines.length > 8 ? (
            <p className="font-mono text-[0.67rem] leading-relaxed text-muted-foreground/65">
              {t.agents.moreFiles(fileLines.length - 8)}
            </p>
          ) : null}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className="grid min-w-0 gap-3 pl-6">
          {node.children.map(child => (
            <SubagentRow
              depth={depth + 1}
              key={child.id}
              node={child}
              nowMs={nowMs}
              onOpen={onOpen}
              parentSessionId={node.sessionId}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
