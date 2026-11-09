import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { I18nProvider } from '@/i18n/context'
import type { ChatMessage } from '@/lib/chat-messages'
import type * as SessionStatesStore from '@/store/session-states'
import { $subagentsBySession, clearSessionSubagents, upsertSubagent } from '@/store/subagents'
import type * as WindowsStore from '@/store/windows'

import { DelegateTool } from './delegate'

// A subagent card must keep opening its subagent after the live store forgets it:
// when the subagent finishes, after a reload and after a restart (live-audit L1),
// and for nested subagents whose card lives in the middle subagent's page (L2).

const opened = vi.hoisted(() => ({ tab: [] as string[], watch: [] as string[], located: [] as unknown[] }))

vi.mock('@/app/open-session', () => ({
  openSession: (id: string, _navigate: unknown, intent: string) => {
    if (intent === 'tab') {
      opened.tab.push(id)
    }
  }
}))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  isWatchWindow: () => false,
  openSessionInNewWindow: async (id: string, opts?: { watch?: boolean }) => {
    if (opts?.watch) {
      opened.watch.push(id)
    }
  }
}))

const locate = vi.hoisted(() => ({ reply: null as unknown }))

vi.mock('@/store/session-states', async importOriginal => ({
  ...(await importOriginal<typeof SessionStatesStore>()),
  requestForOwnedSession: async (_sid: string, _ambient: unknown, method: string, params: unknown) => {
    opened.located.push({ method, params })

    return locate.reply
  }
}))

const RUNTIME = 'runtime-parent'

function view(): SessionView {
  return {
    kind: 'primary',
    $runtimeId: atom<string | null>(RUNTIME),
    $storedId: atom<string | null>('stored-parent'),
    $messages: atom<ChatMessage[]>([]),
    $busy: atom(false),
    $awaitingResponse: atom(false),
    $messagesEmpty: atom(true),
    $lastVisibleIsUser: atom(false),
    $turnStartedAt: atom<null | number>(null),
    $cwd: atom(''),
    $model: atom(''),
    $provider: atom(''),
    $fast: atom(false),
    $reasoningEffort: atom(''),
    $reasoningEffortPending: atom(false),
    $reasoningEffortWire: atom('')
  } satisfies SessionView
}

const ARGS = { tasks: [{ goal: 'subagent alpha' }, { goal: 'subagent beta' }] }

let call = 0

// A fresh call id per render: lookups are cached per call.
function renderCard(result: unknown) {
  call += 1

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SessionViewProvider value={view()}>
        <DelegateTool args={ARGS} result={result} toolCallId={`call-${call}`} />
      </SessionViewProvider>
    </I18nProvider>
  )
}

const goalButton = (container: HTMLElement, goal: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-delegate-card] button')].find(b => b.textContent === goal)!

beforeEach(() => {
  opened.tab.length = 0
  opened.watch.length = 0
  opened.located.length = 0
  locate.reply = null
})

afterEach(() => {
  cleanup()
  clearSessionSubagents(RUNTIME)
  $subagentsBySession.set({})
  vi.restoreAllMocks()
})

describe('delegate card opens its subagent forever', () => {
  it('opens a finished subagent from the ids its call result names, as a full page beside the parent', async () => {
    locate.reply = { children: [{ task_index: 1, child_session_id: 'child-beta', running: false }] }

    const { container } = renderCard({
      status: 'dispatched',
      goals: ['subagent alpha', 'subagent beta'],
      child_session_ids: ['child-alpha', 'child-beta'],
      subagent_ids: ['sa-0-aaaa', 'sa-1-bbbb']
    })

    const beta = goalButton(container, 'subagent beta')
    expect(beta.disabled).toBe(false)
    expect(beta.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe('child-beta')
    expect(beta.closest('[data-subagent-id]')?.getAttribute('data-subagent-id')).toBe('sa-1-bbbb')

    fireEvent.click(beta)
    await waitFor(() => expect(opened.tab).toEqual(['child-beta']))
    expect(opened.watch).toEqual([])
  })

  it('locates the subagent of a card whose result names no child (stored before child ids existed)', async () => {
    locate.reply = {
      children: [
        { task_index: 0, child_session_id: 'legacy-alpha', running: false },
        { task_index: 1, child_session_id: null, running: false }
      ]
    }

    const { container } = renderCard({ status: 'dispatched', goals: ['subagent alpha', 'subagent beta'] })
    const alpha = goalButton(container, 'subagent alpha')

    expect(alpha.disabled).toBe(false)
    fireEvent.click(alpha)
    await waitFor(() => expect(opened.tab).toEqual(['legacy-alpha']))
    expect(opened.located).toEqual([
      { method: 'subagent.locate', params: { session_id: RUNTIME, tool_call_id: `call-${call}` } }
    ])
  })

  it('watches a subagent the backend says is still running instead of offering it a composer', async () => {
    locate.reply = { children: [{ task_index: 0, child_session_id: 'child-alpha', running: true }] }

    const { container } = renderCard({
      status: 'dispatched',
      goals: ['subagent alpha', 'subagent beta'],
      child_session_ids: ['child-alpha', 'child-beta']
    })

    fireEvent.click(goalButton(container, 'subagent alpha'))
    await waitFor(() => expect(opened.watch).toEqual(['child-alpha']))
    expect(opened.tab).toEqual([])
  })

  it('opens a live running subagent read-only in a watch window, without asking the backend', async () => {
    upsertSubagent(RUNTIME, {
      child_session_id: 'child-alpha',
      goal: 'subagent alpha',
      status: 'running',
      subagent_id: 'sa-0-aaaa',
      task_index: 0
    })

    const { container } = renderCard(undefined)

    fireEvent.click(goalButton(container, 'subagent alpha'))
    await waitFor(() => expect(opened.watch).toEqual(['child-alpha']))
    expect(opened.located).toEqual([])
  })
})
