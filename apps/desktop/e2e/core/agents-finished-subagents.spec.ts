/**
 * The Agents tab keeps this chat's finished subagents: after they finish, after a
 * renderer reload and after an app + backend restart, each row still shows how it
 * ended and the route that actually served it (here a fallback), and Open shows its
 * read-only transcript. A failed history read offers Retry instead of claiming the
 * chat never delegated.
 *
 * Real Electron + real backend, sandboxed HOME, scripted fake LLM with named routes.
 * Nothing seeds UI stores. The history-read failure is injected in the Electron main
 * process for the child-listing path only, then lifted for Retry.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type ElectronApplication, expect, type Page, test } from '@playwright/test'

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
import { type ScriptedProvider, startScriptedProvider } from './provider'

const n = Math.random()
  .toString(36)
  .slice(2, 7)
  .replace(/[^a-z0-9]/g, 'q')

const U1 = `U1-${n}`
const K = (i: number) => `K${i}-${n}`
const CTX = (i: number) => `CTX${i}${n}`
const EVID = process.env.HERMES_E2E_AGENTS_HISTORY_EVIDENCE || ''

const cleanups: (() => Promise<void> | void)[] = []
test.afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

/** Subagents launch on a failing route; the backend's fallback serves them. */
function config(provider: ScriptedProvider): string {
  const named = Object.entries(provider.routes)
    .map(
      ([name, r]) =>
        `  ${name}:\n    api: ${r.url}/v1\n    api_mode: chat_completions\n    key_env: MOCK_API_KEY\n` +
        `    context_length: 64000\n    models:\n      ${r.model}: {}`
    )
    .join('\n')

  return (
    `model:\n  default: parent-model\n  provider: parent\nproviders:\n${named}\n` +
    `auxiliary:\n  title_generation:\n    enabled: false\nagent:\n  api_max_retries: 1\napprovals:\n  mode: off\n` +
    `memory:\n  provider: none\n  memory_enabled: false\nsecurity:\n  allow_lazy_installs: false\n` +
    `fallback_providers: []\ndelegation:\n  provider: broken\n  model: failed-model\n` +
    `  fallback_providers:\n    - provider: rescue\n      model: fallback-model\n`
  )
}

async function capture(page: Page, name: string) {
  if (!EVID) {
    return
  }

  fs.mkdirSync(EVID, { recursive: true })

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(400)
    await page.screenshot({ animations: 'disabled', path: path.join(EVID, `${name}-${scheme}.png`) })
  }

  await page.emulateMedia({ colorScheme: null, reducedMotion: null })
}

/** The Agents row for `goal` (delegate cards in the chat carry no Open control). */
const agentRow = (page: Page, goal: string) =>
  page.locator('[data-subagent-id]:has([data-subagent-open])', { hasText: goal }).filter({ visible: true }).last()

let parentId = ''

async function openAgents(page: Page) {
  // Route by id: a reload can briefly retitle the parent in the sidebar.
  await page.evaluate(() => (location.hash = '#/'))
  await page.evaluate(id => (location.hash = `#/${id}`), parentId)
  await expect(page.locator('[data-slot="composer-root"]').filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 })
  await page.evaluate(() => (location.hash = '#/agents'))
}

async function expectRecovered(page: Page, label: string) {
  for (const goal of ['subagent alpha', 'subagent beta']) {
    const row = agentRow(page, goal)
    await expect(row, `${label}: ${goal} listed`).toHaveAttribute('data-subagent-status', 'completed', { timeout: 30_000 })
    await expect(row, `${label}: ${goal} keeps its child session`).toHaveAttribute('data-session-id', /.+/)
    // The observed route, not the failed launch route.
    await expect(row, `${label}: ${goal} route`).toContainText('rescue · fallback-model')
    await expect(row).toContainText('Fallback')
    await expect(row).not.toContainText('failed-model')
  }
}

/** Fail only the child-listing REST path, inside the Electron main process's `hermes:api` handler. */
async function failHistoryReads(app: ElectronApplication, fail: boolean) {
  await app.evaluate(({ ipcMain }, on) => {
    const g = globalThis as { __agentsHistoryFail?: boolean; __agentsHistoryWrapped?: boolean }
    g.__agentsHistoryFail = on

    if (g.__agentsHistoryWrapped) {
      return
    }

    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get('hermes:api')!
    ipcMain.removeHandler('hermes:api')
    ipcMain.handle('hermes:api', (event, request: { path?: string }) => {
      if (g.__agentsHistoryFail && /\/api\/sessions\/[^/]+\/subagents/.test(request?.path ?? '')) {
        throw new Error('503: session store unavailable')
      }

      return original(event, request)
    })
    g.__agentsHistoryWrapped = true
  }, fail)
}

test('finished subagents stay in Agents across reload and restart, with their route, and open read-only', async () => {
  test.setTimeout(600_000)

  const provider = await startScriptedProvider({
    // Each subagent's script is keyed by its goal (its first user message).
    routing: 'first-user',
    routes: {
      parent: { model: 'parent-model' },
      broken: { model: 'failed-model', httpStatus: 503 },
      rescue: { model: 'fallback-model' }
    }
  })

  const sandbox = createCoreSandbox('agents-finished-subagents')
  cleanups.push(() => provider.close(), () => sandbox.cleanup())
  writeProviderHome(sandbox.hermesHome, provider.url)
  fs.writeFileSync(path.join(sandbox.hermesHome, 'config.yaml'), config(provider))
  fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled":false}\n')

  provider.script(U1, [
    {
      text: ['Delegating two subagents.'],
      toolCalls: [
        {
          name: 'delegate_task',
          args: { tasks: [{ goal: `${K(11)} subagent alpha: inspect` }, { goal: `${K(12)} subagent beta: inspect` }] }
        }
      ]
    },
    { text: ['Both subagents finished.'] }
  ])

  // Each subagent says a unique token in a working step only its own transcript shows.
  for (const i of [11, 12]) {
    provider.script(K(i), [
      { text: [`working ${CTX(i)}`], toolCalls: [{ name: 'terminal', args: { command: `echo step-${i}` } }] },
      { text: [`subagent ${i} final summary.`] }
    ])
  }

  let { app, page } = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' }))
  cleanups.push(() => app.close().catch(() => undefined))

  await waitForInteractive(app, page)
  const ws = recordWebSockets(page)
  await send(page, `${U1} please delegate two subagents`, 'Enter', ws)
  parentId = await currentSessionId(page)
  await expect
    .poll(() => provider.completions.some(r => r.marker === U1 && r.step === 1 && r.finished), { timeout: 180_000 })
    .toBe(true)

  // ── finished, same window ──
  await openAgents(page)
  await expectRecovered(page, 'finished')

  // ── renderer reload: the live store is gone; rows come from stored history ──
  await page.evaluate(id => (location.hash = `#/${id}`), parentId)
  await page.reload()
  await waitForInteractive(app, page)
  await openAgents(page)
  await expectRecovered(page, 'reload')
  await capture(page, 'agents-history-after-reload')

  await app.close()
  expect(stopSandboxGateway(sandbox, { interrupt: true }).code).toBe(0)
  await expect.poll(() => backendProcesses(sandbox)).toHaveLength(0)

  // ── app + backend restart on the same home ──
  ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' })))
  cleanups.push(() => app.close().catch(() => undefined))
  await waitForInteractive(app, page)
  await openAgents(page)
  await expectRecovered(page, 'restart')

  const requests = provider.completions.length
  await agentRow(page, 'subagent alpha').locator('[data-subagent-open]').click()
  await expect(page.locator('[data-subagent-open]').filter({ visible: true })).toHaveCount(0)
  await expect(page.getByText(CTX(11)).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-slot="subagent-read-only"]').filter({ visible: true }).first()).toBeVisible()
  await expect(page.locator('[data-slot="composer-root"]').filter({ visible: true })).toHaveCount(0)
  expect(provider.completions.length, 'opening a subagent never asks a model').toBe(requests)

  // ── a failed history read is not an empty chat; Retry recovers ──
  await page.locator('[data-tree-tab="workspace"]').filter({ visible: true }).first().click()
  await failHistoryReads(app, true)
  await openAgents(page)
  await expect(page.getByText('Couldn’t load earlier subagents.').filter({ visible: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('No subagents in this chat')).toHaveCount(0)
  await capture(page, 'agents-history-failed')
  await failHistoryReads(app, false)
  await page.getByRole('button', { name: 'Retry' }).filter({ visible: true }).first().click()
  await expectRecovered(page, 'retry')
})
