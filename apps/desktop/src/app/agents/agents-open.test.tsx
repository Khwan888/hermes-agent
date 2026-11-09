import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $activeSessionId } from '@/store/session'
import {
  $finishedSubagentsBySession,
  $subagentsBySession,
  pruneFinishedSessionSubagents,
  upsertSubagent
} from '@/store/subagents'
import type * as WindowsStore from '@/store/windows'

import { AgentsView } from '.'

// Agents rows open their subagent (live-audit L6): a finished one as its full
// page, a running one — nested grandchildren included (L2) — read-only.

const opened = vi.hoisted(() => ({ tab: [] as string[], watch: [] as string[] }))

vi.mock('@/app/open-session', () => ({
  openSession: (id: string, _navigate: unknown, intent: string) => intent === 'tab' && opened.tab.push(id)
}))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  isWatchWindow: () => false,
  openSessionInNewWindow: async (id: string, opts?: { watch?: boolean }) => opts?.watch && opened.watch.push(id)
}))

beforeAll(() => {
  // jsdom has no Web Animations; rows animate in on mount.
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as never
})

afterEach(() => {
  cleanup()
  $subagentsBySession.set({})
  $finishedSubagentsBySession.set({})
  $activeSessionId.set(null)
  opened.tab.length = 0
  opened.watch.length = 0
})

const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-subagent-id="${id}"]`)!

describe('Agents tab rows', () => {
  it('keeps an earlier turn\u2019s finished subagent and opens it; a running grandchild opens read-only', () => {
    $activeSessionId.set('s1')
    upsertSubagent('s1', {
      child_session_id: 'child-alpha',
      goal: 'subagent alpha',
      status: 'completed',
      subagent_id: 'alpha',
      task_index: 0
    })
    pruneFinishedSessionSubagents('s1') // the next turn started
    upsertSubagent('s1', {
      child_session_id: 'child-beta',
      goal: 'subagent beta',
      status: 'running',
      subagent_id: 'beta',
      task_index: 0
    })
    upsertSubagent('s1', {
      child_session_id: 'child-gamma',
      goal: 'grandchild gamma',
      parent_id: 'beta',
      status: 'running',
      subagent_id: 'gamma',
      task_index: 0
    })

    const onClose = vi.fn()

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <AgentsView onClose={onClose} />
      </I18nProvider>
    )

    expect(row(container, 'gamma').getAttribute('data-parent-session-id')).toBe('child-beta')
    expect(row(container, 'alpha').getAttribute('data-subagent-status')).toBe('completed')

    fireEvent.click(row(container, 'gamma').querySelector('[data-subagent-open]')!)
    expect(opened.watch).toEqual(['child-gamma'])
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(row(container, 'alpha').querySelector('[data-subagent-open]')!)
    expect(opened.tab).toEqual(['child-alpha'])
    expect(onClose).toHaveBeenCalledOnce()
  })
})
