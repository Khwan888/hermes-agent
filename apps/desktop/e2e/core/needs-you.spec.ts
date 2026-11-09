/**
 * Subagents needing attention flag themselves on existing surfaces:
 * a parent delegates alpha (finishes) and beta, beta delegates gamma, and gamma's model stream
 * goes silent. With `delegation.stuck_after_seconds` set low, gamma reads `stuck`; the flag rolls
 * up to the parent's folded "N subagents" control and un-hides the (hidden-by-default) Agents
 * status-bar item. When gamma resumes the stuck flag clears and the finished subagents read
 * `unread` on the fold; opening each subagent clears it. Nothing is flagged before any subagent ran
 * (lean main page).
 *
 * Real Electron + real `hermes serve`, sandboxed HOME, scripted fake LLM (no model calls).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import {
  coreAppEnv,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  recordWebSockets,
  send,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { gate, startScriptedProvider } from './provider'

const EVID = process.env.NEEDS_YOU_EVIDENCE || ''

const n = Math.random()
  .toString(36)
  .slice(2, 7)
  .replace(/[^a-z0-9]/g, 'q')

const U1 = `U1-${n}`
const K = (i: number) => `K${i}-${n}`

const setMode = async (page: Page, mode: 'light' | 'dark') => {
  await page.evaluate(mode => {
    const key = 'hermes-desktop-mode-v1'
    const oldValue = localStorage.getItem(key)
    localStorage.setItem(key, mode)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: mode, storageArea: localStorage }))
  }, mode)
  await expect(page.locator('html')).toHaveAttribute('data-hermes-mode', mode)
}

const shot = async (page: Page, name: string) => {
  if (EVID) {
    fs.mkdirSync(EVID, { recursive: true })
    const wasDark = (await page.locator('html').getAttribute('data-hermes-mode')) === 'dark'

    for (const mode of ['light', 'dark'] as const) {
      await setMode(page, mode)
      await page.screenshot({ path: path.join(EVID, `${name}-${mode}.png`), animations: 'disabled' })
    }

    await setMode(page, wasDark ? 'dark' : 'light')
  }
}

const attentionOf = (page: Page, sessionId: string) =>
  page
    .locator(`[data-session-id="${sessionId}"] [data-subagent-count]`)
    .first()
    .getAttribute('data-subagent-attention')
    .catch(() => 'missing-fold')

/** The visible sidebar row (not a tab/card) for a subagent whose goal contains `goal`. */
const subagentRow = (page: Page, parentId: string, goal: string) =>
  page.locator(`[data-subagent-children="${parentId}"] [data-parent-session-id="${parentId}"]`, { hasText: goal }).first()

const statusbarAgents = (page: Page) => page.locator('button[data-subagent-attention]', { hasText: /need/i })

test('stuck and finished-unread subagents roll up to the folded parent and clear', async () => {
  test.setTimeout(600_000)
  const provider = await startScriptedProvider({ routing: 'first-user' })
  const sandbox = createCoreSandbox('needs-you')
  writeProviderHome(
    sandbox.hermesHome,
    provider.url,
    'delegation:\n  max_spawn_depth: 2\n  orchestrator_enabled: true\n  stuck_after_seconds: 3\n' +
      'memory:\n  provider: none\n  memory_enabled: false\n'
  )
  fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled": false}\n')

  const quiet = gate()

  provider.script(U1, [
    {
      text: ['Delegating ', 'two subagents.'],
      toolCalls: [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              { goal: `${K(21)} subagent alpha: quick look` },
              { goal: `${K(22)} subagent beta: orchestrate a nested subagent` }
            ]
          }
        }
      ]
    },
    { text: ['Subagents ', 'dispatched; ending my turn.'] }
  ])
  provider.script(`${U1}~n`, [{ text: ['Parent ', 'received subagent results.'] }])
  provider.script(K(21), [{ text: ['alpha ', 'final summary.'] }])
  provider.script(K(22), [
    {
      text: ['beta delegating.'],
      toolCalls: [{ name: 'delegate_task', args: { goal: `${K(23)} grandchild gamma: slow check` } }]
    },
    { text: ['beta ', 'final summary.'] }
  ])
  // gamma's first reply goes silent after one chunk until the gate opens: no progress events.
  provider.script(K(23), [
    { text: ['gamma thinking ', 'then done.'], holdAfterFirstChunk: quiet },
    { text: ['gamma ', 'final summary.'] }
  ])

  const { app, page } = await launchCoreApp(coreAppEnv(sandbox))

  try {
    await waitForInteractive(app, page)

    // ── lean: nothing flagged, no fold, Agents item hidden before any subagent ──
    await expect(page.locator('[data-subagent-attention]')).toHaveCount(0)
    await expect(page.locator('[data-subagent-count]')).toHaveCount(0)
    await shot(page, '00-empty-main')

    const ws = recordWebSockets(page)
    await send(page, `${U1} please delegate two subagents`, 'Enter', ws)
    const parentId = await currentSessionId(page)

    // ── gamma silent → stuck rolls up to the folded parent row and the status bar ──
    await provider.streamStarted(K(23))
    await expect
      .poll(() => attentionOf(page, parentId), { message: 'parent fold flags stuck', timeout: 60_000 })
      .toBe('stuck')
    await expect(page.locator(`[data-session-id="${parentId}"] [data-subagent-count]`).first()).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(statusbarAgents(page)).toHaveAttribute('data-subagent-attention', 'stuck')
    await shot(page, '01-no-progress-rolled-up')

    if (EVID) {
      for (const mode of ['light', 'dark'] as const) {
        await setMode(page, mode)
        await statusbarAgents(page).screenshot({ path: path.join(EVID, `agents-chip-${mode}.png`), animations: 'disabled' })
      }
    }

    // ── gamma resumes → stuck clears; the finished subagents read unread on the fold ──
    quiet.open()
    await expect.poll(() => provider.completions.some(r => r.marker === `${U1}~n` && r.finished), { timeout: 120_000 }).toBe(true)
    await expect
      .poll(() => attentionOf(page, parentId), { message: 'parent fold flags unread', timeout: 60_000 })
      .toBe('unread')
    await expect(statusbarAgents(page)).toHaveCount(0)
    await shot(page, '02-finished-unread')

    // ── open each subagent from the fold: the flag counts down and clears ──
    const parentFold = page.locator(`[data-session-id="${parentId}"] [data-subagent-count]`).first()

    const pendingCount = async () =>
      Number(/· (\d+) ·/.exec((await parentFold.getAttribute('aria-label')) ?? '')?.[1] ?? 0)

    await expect.poll(pendingCount).toBe(3)
    await parentFold.click()

    const openRow = async (row: ReturnType<typeof subagentRow>, goal: string) => {
      await expect(row).toBeVisible({ timeout: 30_000 })
      await row
        .getByRole('button', { name: new RegExp(`^Subagent: .*${goal}`) })
        .first()
        .click()
    }

    const alpha = subagentRow(page, parentId, 'subagent alpha')
    const beta = subagentRow(page, parentId, 'subagent beta')
    await openRow(alpha, 'subagent alpha')
    await expect.poll(pendingCount, { message: 'opening alpha clears one', timeout: 30_000 }).toBe(2)
    await openRow(beta, 'subagent beta')
    await expect.poll(pendingCount, { message: 'opening beta clears one', timeout: 30_000 }).toBe(1)
    await beta.locator('[data-subagent-count]').first().click()
    const betaId = (await beta.getAttribute('data-session-id')) ?? ''
    await openRow(subagentRow(page, betaId, 'grandchild gamma'), 'grandchild gamma')
    await expect
      .poll(async () => `${await attentionOf(page, parentId)} ${await parentFold.getAttribute('aria-label')}`, {
        message: 'parent fold flag clears after opening',
        timeout: 30_000
      })
      .toBe('null 2 subagents')
    await expect(page.locator('[data-subagent-attention]')).toHaveCount(0)
    await shot(page, '03-cleared-after-open')
  } finally {
    await app.close().catch(() => undefined)
    await provider.close()
    sandbox.cleanup()
  }
})
