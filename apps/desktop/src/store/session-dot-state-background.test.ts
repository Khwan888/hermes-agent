import { afterEach, describe, expect, it } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import type { SessionInfo } from '@/types/hermes'

import { $liveWorkRoster, setLiveWorkRosterSource } from './live-work-roster'
import { $sessions, $unreadFinishedSessionIds } from './session'
import { $sessionDotStateById } from './session-dot-state'
import { clearAllSessionStates, publishSessionState } from './session-states'
import { $unreadWriteGuard } from './session-unread-remote'

afterEach(() => {
  clearAllSessionStates()
  $liveWorkRoster.set({})
  $sessions.set([])
  $unreadFinishedSessionIds.set([])
  $unreadWriteGuard.set(new Map())
})

describe('finished unread beside background work (#147195)', () => {
  it.each([
    ['background', 'persisted'],
    ['background', 'transient'],
    ['subagents', 'persisted'],
    ['subagents', 'transient']
  ] as const)('keeps %s work running while %s unread is shown and cleared', (kind, unreadSource) => {
    const row = { id: 'stored', message_count: 1, source: 'cli', started_at: 0, title: 'Chat' } as SessionInfo
    $sessions.set([row])
    setLiveWorkRosterSource('ambient', [
      { session_id: row.id, background: kind === 'background' ? 1 : 0, subagents: kind === 'subagents' ? 1 : 0 }
    ])
    expect($sessionDotStateById.get()[row.id]).toBe('background')

    if (unreadSource === 'persisted') {
      $sessions.set([{ ...row, unread: true }])
    } else {
      $unreadFinishedSessionIds.set([row.id])
    }

    expect($sessionDotStateById.get()[row.id]).toBe('unread')

    publishSessionState('runtime', { ...createClientSessionState(row.id), busy: true })
    expect($sessionDotStateById.get()[row.id]).toBe('working')
    clearAllSessionStates()
    expect($sessionDotStateById.get()[row.id]).toBe('unread')

    $sessions.set([{ ...row, unread: false }])
    $unreadFinishedSessionIds.set([])
    expect($sessionDotStateById.get()[row.id]).toBe('background')

    setLiveWorkRosterSource('ambient', [], Date.now(), [row.id])
    expect($sessionDotStateById.get()[row.id] ?? 'idle').toBe('idle')
  })
})
