import { cleanup, fireEvent, render } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { toChatMessages } from '@/lib/chat-messages/hydration'
import { toRuntimeMessage } from '@/lib/chat-runtime'

import { BackgroundResult } from './system-message'

const state = vi.hoisted(() => ({ open: vi.fn(), locate: vi.fn(), messages: [] as unknown[] }))
vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => ({
  $storedId: atom('parent'), $runtimeId: atom('runtime'), $messages: atom(state.messages)
}) }))
vi.mock('@/app/open-subagent', () => ({ locateSubagent: state.locate, openSubagent: state.open }))
vi.mock('@/store/session-states', () => ({ knownOwnerForSession: () => ({ connectionId: 'remote', profile: 'work' }) }))
vi.mock('./timeline-timestamp', () => ({ MessageTimelineTimestamp: () => null }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const content = '[ASYNC DELEGATION BATCH COMPLETE — batch-1]\nPrivate instructions\n\n--- ✓ TASK 1/2: alpha  (status=completed) ---\nalpha report'

function show() {
  return render(<I18nProvider configClient={null} initialLocale="en"><BackgroundResult delegationId="batch-1" report="Reports" text="Subagent Tasks Completed" /></I18nProvider>)
}

test('preserves only producer-owned completion identity through hydration and runtime conversion', () => {
  const typed = toRuntimeMessage(toChatMessages([{ role: 'user', content, display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'batch-1', task_count: 2 } }])[0])
  expect(typed.metadata.custom.asyncDelegationId).toBe('batch-1')
  const legacy = toRuntimeMessage(toChatMessages([{ role: 'user', content, display_kind: 'async_delegation_complete' }])[0])
  expect(legacy.metadata.custom.asyncDelegationId).toBe('batch-1')
  const quoted = toRuntimeMessage(toChatMessages([{ role: 'user', content }])[0])
  expect(quoted.metadata.custom.asyncDelegationId).toBeUndefined()
})

test('opens only this dispatch’s exact children after remount, with no live roster', async () => {
  state.messages = toChatMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'spawn-1', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ tasks: [{ goal: 'alpha' }, { goal: 'beta' }] }) } }] },
    { role: 'tool', tool_name: 'delegate_task', tool_call_id: 'spawn-1', content: JSON.stringify({ status: 'dispatched', delegation_id: 'batch-1' }) }
  ])
  state.locate.mockImplementation(async (_parent: string, _call: string, index: number) => ({ sessionId: index ? 'child-beta' : 'child-alpha', running: false }))

  for (const phase of ['initial', 'remount']) {
    const ui = show()
    fireEvent.click(ui.getByRole('button', { name: 'Subagent Tasks Completed' }))
    const beta = await ui.findByRole('button', { name: 'beta' })
    fireEvent.click(beta)
    expect(state.open, phase).toHaveBeenLastCalledWith({ sessionId: 'child-beta', running: false }, { parentSessionId: 'parent' })
    expect(state.locate).toHaveBeenCalledWith('runtime', 'spawn-1', 1)
    ui.unmount()
  }
})

test('an unavailable legacy child offers retry instead of substituting a goal-matching sibling', async () => {
  state.messages = [{ id: 'call', role: 'assistant', parts: [{ type: 'tool-call', toolName: 'delegate_task', toolCallId: 'spawn-retry', args: { goal: 'alpha' }, result: { status: 'dispatched', delegation_id: 'batch-1' } }] }]
  state.locate.mockResolvedValueOnce(null).mockResolvedValue({ sessionId: 'child-beta', running: false })
  const ui = show()
  fireEvent.click(ui.getByRole('button', { name: 'Subagent Tasks Completed' }))
  await ui.findByRole('button', { name: 'Retry' })
  fireEvent.click(ui.getByRole('button', { name: 'Retry' }))
  await ui.findByRole('button', { name: 'alpha' })
})

test('does not resolve another dispatch with identical goals', () => {
  state.messages = []
  const ui = show()
  fireEvent.click(ui.getByRole('button', { name: 'Subagent Tasks Completed' }))
  expect(state.locate).not.toHaveBeenCalled()
})
