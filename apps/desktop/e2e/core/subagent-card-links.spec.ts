/**
 * Every subagent stays one click away (live-audit L1/L2/L4/L6): a parent
 * delegates subagents alpha and beta in the background, beta delegates a
 * grandchild gamma. After they all finish the parent's card must still open
 * alpha — in the same window, after a reload, after an app restart, and after
 * a restart over history written before child ids existed (no `_subagent_id`
 * marker, no ids in the call result: most of a long-lived store). The card
 * opens the subagent's full read-only page as a tab beside the parent;
 * gamma opens from beta's page. Completion notices use the same exact dispatch.
 *
 * Real Electron + real `hermes serve`, sandboxed HOME, scripted fake LLM.
 * Each subagent says a unique token in a working step before its final reply;
 * only that subagent's own transcript renders it (the card and the parent's
 * completion notice carry goals and final summaries), so "the subagent opened"
 * is "its token became visible".
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, type Page, test } from '@playwright/test'

import {
  backendProcesses,
  coreAppEnv,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  recordWebSockets,
  send,
  stopSandboxGateway,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { gate, startScriptedProvider } from './provider'

const EVID = process.env.SUBAGENT_LINK_EVIDENCE || ''
const cleanups: (() => Promise<void> | void)[] = []
test.afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const n = Math.random()
  .toString(36)
  .slice(2, 7)
  .replace(/[^a-z0-9]/g, 'q')

const U1 = `U1-${n}`
const K = (i: number) => `K${i}-${n}`
const CTX = (i: number) => `CTX${i}${n}`

const shot = async (page: Page, name: string) => {
  if (EVID) {
    fs.mkdirSync(EVID, { recursive: true })
    await page.screenshot({ path: path.join(EVID, `${name}.png`) }).catch(() => undefined)
  }
}

/** Some element showing `text` is on screen and on top (a background tab keeps its DOM mounted). */
const visibleText = (page: Page, text: string) =>
  page.evaluate(needle => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.childElementCount !== 0 || !(el.textContent ?? '').includes(needle)) {
        continue
      }

      const r = el.getBoundingClientRect()
      const x = r.left + Math.min(r.width / 2, 8)
      const y = r.top + r.height / 2

      if (r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
        const hit = document.elementFromPoint(x, y)

        if (hit && (hit === el || el.contains(hit) || hit.contains(el))) {
          return true
        }
      }
    }

    return false
  }, text)

const cardButton = (page: Page, goal: string) =>
  page.locator('[data-delegate-card] button', { hasText: goal }).filter({ visible: true }).first()

let parentId = ''

async function backToParent(page: Page) {
  // Restored child tabs can stay in front while hash navigation updates the hidden main pane.
  const mainTab = page.locator('[data-tree-tab="workspace"]').filter({ visible: true }).first()

  await expect(mainTab).toBeVisible({ timeout: 60_000 })
  // After a restart the connecting overlay covers the tab until the backend is up (waitForInteractive's budget).
  await mainTab.click({ timeout: 180_000 })

  // The parent's sidebar title flips to "Untitled session" across a reload (live-audit L12): route by id.
  await page.evaluate(() => (location.hash = '#/'))
  await sleep(500)
  await page.evaluate(id => (location.hash = `#/${id}`), parentId)
  await expect(cardButton(page, 'subagent alpha')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => visibleText(page, CTX(11))).toBe(false)
}

/** Click the visible card row for `goal`; its subagent's own page must come up in this window. */
async function cardOpens(page: Page, goal: string, token: string, label: string) {
  const windowsBefore = page.context().pages().length
  const button = cardButton(page, goal)
  await expect(button, `${label}: card button for ${goal}`).toBeEnabled({ timeout: 20_000 })
  expect(await visibleText(page, token), `${label}: ${token} not on screen before the click`).toBe(false)
  await button.click()
  await expect
    .poll(() => visibleText(page, token), { message: `${label}: subagent page shows ${token}`, timeout: 30_000 })
    .toBe(true)
  expect(page.url(), 'finished subagent opens the full page, not a watch window').not.toContain('watch=1')
  // Owner decision: the full page is a read-only record with the subagent strip, never a second writer.
  await expect(page.locator('[data-slot="subagent-read-only"]').filter({ visible: true }).first()).toHaveText('Subagent · Read-only transcript')
  await expect(page.locator('[data-slot="composer-root"]').filter({ visible: true })).toHaveCount(0)
  expect(page.context().pages().length).toBe(windowsBefore)
  await shot(page, `${label}`)
}

test('subagent cards and completion notices survive finish, reload and backend restart', async () => {
  test.setTimeout(900_000)
  const provider = await startScriptedProvider({ routing: 'first-user' })
  const sandbox = createCoreSandbox('subagent-card-links')
  cleanups.push(() => provider.close(), () => sandbox.cleanup())
  writeProviderHome(
    sandbox.hermesHome,
    provider.url,
    'delegation:\n  max_spawn_depth: 2\n  orchestrator_enabled: true\nmemory:\n  provider: none\n  memory_enabled: false\n'
  )
  fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled": false}\n')

  provider.script(U1, [
    {
      text: ['Delegating ', 'two subagents.'],
      toolCalls: [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              { goal: `${K(11)} subagent alpha: inspect the files` },
              { goal: `${K(12)} subagent beta: orchestrate a nested subagent` }
            ]
          }
        }
      ]
    },
    { text: ['Subagents ', 'dispatched; ending my turn.'] }
  ])
  provider.script(`${U1}~n`, [{ text: ['Parent ', 'received subagent results.'] }])

  const working = (i: number) => ({
    text: [`working ${CTX(i)}`],
    toolCalls: [{ name: 'terminal', args: { command: `echo step-${i}` } }]
  })

  const betaFinish = gate()
  const gammaFinish = gate()
  provider.script(K(11), [working(11), { text: ['alpha ', 'final summary.'] }])
  provider.script(K(12), [
    working(12),
    {
      text: ['beta delegating.'],
      toolCalls: [{ name: 'delegate_task', args: { goal: `${K(13)} grandchild gamma: deep check` } }]
    },
    { text: ['beta ', 'final summary.'], holdBeforeFinish: betaFinish }
  ])
  provider.script(K(13), [{ ...working(13), holdAfterFirstChunk: gammaFinish }, { text: ['gamma ', 'done.'] }])

  let { app, page } = await launchCoreApp(coreAppEnv(sandbox))
  cleanups.push(() => app.close().catch(() => undefined))

  try {
    await waitForInteractive(app, page)
    const ws = recordWebSockets(page)
    await send(page, `${U1} please delegate two subagents`, 'Enter', ws)
    parentId = await currentSessionId(page)
    // A live middle child's own card opens exactly its live nested child.
    await expect.poll(() => provider.completions.some(r => r.marker === K(13)), { timeout: 120_000 }).toBe(true)
    const middleOpening = app.waitForEvent('window')
    await cardButton(page, 'subagent beta').click()
    const middle = await middleOpening
    const gammaButton = cardButton(middle, 'grandchild gamma')
    await expect(gammaButton).toBeEnabled({ timeout: 30_000 })
    const nestedOpening = app.waitForEvent('window')
    await gammaButton.click()
    const nested = await nestedOpening
    await expect.poll(() => visibleText(nested, `${K(13)} grandchild gamma: deep check`), { timeout: 30_000 }).toBe(true)
    await expect(nested.locator('[data-slot="composer-root"]').filter({ visible: true })).toHaveCount(0)
    gammaFinish.open()
    await expect.poll(() => visibleText(nested, CTX(13)), { timeout: 30_000 }).toBe(true)
    betaFinish.open()
    await nested.close()
    await middle.close()
    // All three subagents finish and the parent takes the async completion notice.
    await expect.poll(() => provider.completions.some(r => r.marker === `${U1}~n` && r.finished), { timeout: 120_000 }).toBe(true)
    await sleep(3000)
    await shot(page, '01-after-finish')
    const notice = page.locator('[data-slot="aui_system-message-root"]').filter({ visible: true }).filter({ hasText: 'Subagent' }).last()
    await notice.locator('button').first().click()
    const noticeAlpha = notice.locator('[data-subagent-open]').filter({ hasText: 'subagent alpha' })
    await expect(noticeAlpha).toBeVisible({ timeout: 20_000 })
    await noticeAlpha.click()
    await expect.poll(() => visibleText(page, CTX(11)), { timeout: 30_000 }).toBe(true)
    await backToParent(page)

    const requestsBeforeOpen = provider.completions.length
    // ── same window, subagents finished ──
    await cardOpens(page, 'subagent alpha', CTX(11), '02-finished-alpha')
    await backToParent(page)
    await cardOpens(page, 'subagent beta', CTX(12), '03-finished-beta')
    // gamma, from beta's page (a grandchild: the parent's card never lists it)
    await cardOpens(page, 'grandchild gamma', CTX(13), '04-finished-gamma-from-beta')

    expect(provider.completions.length).toBe(requestsBeforeOpen)
    // ── reload ──
    await page.reload()
    await backToParent(page)
    await waitForInteractive(app, page)
    await cardOpens(page, 'subagent alpha', CTX(11), '07-reload-alpha')
  } finally {
    gammaFinish.open()
    betaFinish.open()
    await app.close().catch(() => undefined)
  }

  expect(stopSandboxGateway(sandbox, { interrupt: true }).code).toBe(0)
  await expect.poll(() => backendProcesses(sandbox)).toHaveLength(0)

  // ── restart on the same home ──
  ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox)))

  try {
    await backToParent(page)
    await waitForInteractive(app, page)
    await cardOpens(page, 'subagent alpha', CTX(11), '08-restart-alpha')
  } finally {
    await app.close().catch(() => undefined)
  }

  expect(stopSandboxGateway(sandbox, { interrupt: true }).code).toBe(0)
  await expect.poll(() => backendProcesses(sandbox)).toHaveLength(0)

  // ── restart over history written before child ids existed ──
  const db = new DatabaseSync(path.join(sandbox.hermesHome, 'state.db'))
  db.exec(`UPDATE sessions SET model_config = json_remove(model_config, '$._subagent_id')
           WHERE source = 'subagent' AND json_valid(model_config)`)

  // Every locator a call result can carry: the dispatch arrays and each settled entry's own ids (beta's
  // nested call to gamma stores them only per entry).
  const results = db
    .prepare(`SELECT id, content FROM messages WHERE role = 'tool' AND tool_name = 'delegate_task' AND json_valid(content)`)
    .all() as { id: number; content: string }[]

  const rewrite = db.prepare('UPDATE messages SET content = ? WHERE id = ?')

  for (const row of results) {
    const result = JSON.parse(row.content)
    delete result.child_session_ids
    delete result.subagent_ids

    for (const entry of [...(result.results ?? []), ...(result.refused ?? [])]) {
      delete entry.child_session_id
      delete entry.subagent_id
    }

    rewrite.run(JSON.stringify(result), row.id)
  }

  const stripped = db
    .prepare(
      `SELECT count(*) AS n FROM messages WHERE role = 'tool' AND tool_name = 'delegate_task'
       AND (instr(content, '"child_session_id') > 0 OR instr(content, '"subagent_id') > 0)`
    )
    .get() as { n: number }

  db.close()
  expect(results.length).toBeGreaterThanOrEqual(2)
  expect(stripped.n).toBe(0)
  ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox)))

  try {
    const ws = recordWebSockets(page)
    await page.reload()
    await backToParent(page)
    await waitForInteractive(app, page)
    await cardOpens(page, 'subagent alpha', CTX(11), '09-legacy-alpha')
    await backToParent(page)
    const parentLocates = new Set(ws.sent.filter(m => m.method === 'subagent.locate').map(m => m.params?.session_id))
    expect(parentLocates.size, 'the parent card located its children').toBeGreaterThan(0)
    await cardOpens(page, 'subagent beta', CTX(12), '10-legacy-beta')
    await cardOpens(page, 'grandchild gamma', CTX(13), '11-legacy-gamma-from-beta')
    // Gamma opened through a locate asked of beta's own session: no stored id was left to open it by.
    expect(
      ws.sent.some(m => m.method === 'subagent.locate' && !parentLocates.has(m.params?.session_id)),
      'nested subagent.locate from beta'
    ).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
  }
})
