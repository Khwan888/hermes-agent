/** Real Electron + sandbox gateway; seed history offline, no model turns. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type ElectronApplication, expect, type Page, test } from '@playwright/test'

import {
  coreAppEnv,
  type CoreSandbox,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  REPO_ROOT,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { startScriptedProvider } from './provider'

const ids = {
  root: 'fold-root',
  other: 'fold-other',
  alpha: 'fold-alpha',
  beta: 'fold-beta',
  gamma: 'fold-gamma',
  delta: 'fold-delta'
}

const titles = {
  root: 'Folded root conversation',
  other: 'No subagent conversation',
  alpha: 'Subagent alpha',
  beta: 'Subagent beta',
  gamma: 'Subagent gamma',
  delta: 'Subagent delta'
}

const evidence = process.env.FOLDED_SIDEBAR_EVIDENCE

function row(page: Page, id: string) {
  return page.locator(`[data-session-id="${id}"]`)
}

async function captureRequests(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => Promise<any>>
    const original = handlers.get('hermes:api')

    if (!original) {
      throw new Error('missing hermes:api handler')
    }

    ;(globalThis as any).__foldRequests = []
    ipcMain.removeHandler('hermes:api')
    ipcMain.handle('hermes:api', async (event: unknown, request: any) => {
      if (/\/api\/sessions\/[^/?]+\/subagents(?:\?|$)/.test(request?.path ?? '')) {
        ;(globalThis as any).__foldRequests.push({ path: request.path, method: request.method ?? 'GET' })
      }

      return original(event, request)
    })
  })
}

async function requests(app: ElectronApplication): Promise<{ path: string; method: string }[]> {
  return app.evaluate(() => (globalThis as any).__foldRequests)
}

function seedStore(sandbox: CoreSandbox, body: string) {
  const python = process.env.HERMES_E2E_PYTHON

  if (!python) {
    throw new Error('HERMES_E2E_PYTHON must select the test interpreter')
  }

  const seed = spawnSync(
    python,
    [
      '-c',
      `
from hermes_state import SessionDB
from pathlib import Path
import os
with SessionDB(db_path=Path(os.environ['HERMES_HOME']) / 'state.db') as db:
${body}
`
    ],
    { cwd: REPO_ROOT, env: coreAppEnv(sandbox), encoding: 'utf8', timeout: 30_000 }
  )

  expect(seed.status, seed.stderr).toBe(0)
}

async function screenshot(page: Page, name: string) {
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true })
    await page.mouse.move(700, 650)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: path.join(evidence, `${name}-${colorScheme}.png`) })
    }

    await page.emulateMedia({ colorScheme: null })
  }
}

test('folded subagents stay nested, follow a new child live, and open through reload and restart', async () => {
  test.setTimeout(300_000)
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('folded-sidebar')
  let app: ElectronApplication | undefined

  try {
    writeProviderHome(sandbox.hermesHome, provider.url, 'memory:\n  provider: none\n  memory_enabled: false\n')
    fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled": false}\n')
    seedStore(
      sandbox,
      `    rows = [
        ('${ids.root}', 'cli', None, '${titles.root}'),
        ('${ids.other}', 'cli', None, '${titles.other}'),
        ('${ids.alpha}', 'subagent', '${ids.root}', '${titles.alpha}'),
        ('${ids.beta}', 'subagent', '${ids.root}', '${titles.beta}'),
        ('${ids.gamma}', 'subagent', '${ids.beta}', '${titles.gamma}'),
    ]
    for sid, source, parent, title in rows:
        db.create_session(sid, source=source, parent_session_id=parent,
                          model_config={'_delegate_from': parent} if source == 'subagent' and sid != '${ids.gamma}' else None)
        db.set_session_title(sid, title)
        db.append_message(sid, 'user', 'Stored transcript for ' + title)`
    )

    let page: Page

    ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox)))
    await captureRequests(app)
    await waitForInteractive(app, page)

    // This also works on origin/main, which has no data-session-id selector.
    const titleButtons = page
      .getByRole('button')
      .filter({ hasText: /^(Folded root conversation|No subagent conversation)$/ })

    await expect(titleButtons).toHaveCount(2)
    console.log('FOLDED-SIDEBAR top-level title RowButtons: 2')
    await screenshot(page, 'initial-folded')
    const root = row(page, ids.root)
    const fold = root.locator('[data-subagent-count]').first()
    // Use text first so the base fails on the user-facing missing affordance.
    await expect(page.getByRole('button', { name: '2 subagents', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(fold).toHaveAttribute('data-subagent-count', '2')
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-session-id]:not([data-subagent-depth])')).toHaveCount(2)
    await expect(row(page, ids.other).locator('[data-subagent-count]')).toHaveCount(0)
    await expect(page.locator('[data-subagent-depth]')).toHaveCount(0)
    expect(await requests(app), 'folded rows do not fetch subagent pages').toEqual([])

    await fold.click()
    await expect(row(page, ids.alpha)).toBeVisible()
    const beta = row(page, ids.beta)
    await expect(beta).toBeVisible()
    await expect(page.locator('[data-subagent-depth="1"]')).toHaveCount(2)
    await expect(row(page, ids.alpha)).toHaveAttribute('data-parent-session-id', ids.root)
    await expect(beta).toHaveAttribute('data-parent-session-id', ids.root)
    await expect(row(page, ids.gamma)).toHaveCount(0)
    await expect(beta.locator('[data-subagent-count="1"]')).toHaveAccessibleName('1 subagent')
    await expect(beta.locator('[data-subagent-count="1"]')).toHaveText('1')
    await beta.locator('[data-subagent-count="1"]').click()
    await expect(row(page, ids.gamma)).toBeVisible()
    await expect(row(page, ids.gamma)).toHaveAttribute('data-parent-session-id', ids.beta)
    await expect(row(page, ids.gamma)).toHaveAttribute('data-subagent-depth', '2')
    await expect(titleButtons).toHaveCount(2)
    await expect(page.locator('[data-session-id]:not([data-subagent-depth])')).toHaveCount(2)
    const fetched = await requests(app)
    expect(fetched).toHaveLength(2)

    for (const [index, id] of [ids.root, ids.beta].entries()) {
      const request = fetched[index]
      expect(request.method).toBe('GET')
      const url = new URL(request.path, 'http://localhost')
      expect(url.pathname).toBe(`/api/sessions/${id}/subagents`)
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('offset')).toBe('0')
    }

    await screenshot(page, 'expanded-nested')

    // Live: a new child of an already open parent appears after a normal list refresh,
    // without folding/reopening and without losing the rows already shown.
    seedStore(
      sandbox,
      `    db.create_session('${ids.delta}', source='subagent', parent_session_id='${ids.root}',
                      model_config={'_delegate_from': '${ids.root}'})
    db.set_session_title('${ids.delta}', '${titles.delta}')
    db.append_message('${ids.delta}', 'user', 'Stored transcript for ${titles.delta}')`
    )
    await page.evaluate(() => new BroadcastChannel('hermes:sessions').postMessage(1))
    await expect(fold).toHaveAttribute('data-subagent-count', '3', { timeout: 30_000 })
    await expect(row(page, ids.delta)).toBeVisible()
    await expect(row(page, ids.delta)).toHaveAttribute('data-subagent-depth', '1')
    await expect(row(page, ids.gamma)).toBeVisible()
    await expect(page.locator('[data-subagent-depth="1"]')).toHaveCount(3)
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    const refreshed = (await requests(app)).slice(2)
    expect(refreshed.length, 'one first-page re-read for the open parent').toBeGreaterThanOrEqual(1)
    expect(new URL(refreshed[0].path, 'http://localhost').pathname).toBe(`/api/sessions/${ids.root}/subagents`)
    expect(new URL(refreshed[0].path, 'http://localhost').searchParams.get('offset')).toBe('0')

    await fold.click()
    await expect(page.locator('[data-subagent-depth]')).toHaveCount(0)
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await page.reload()
    await waitForInteractive(app, page)
    await expect(row(page, ids.root).locator('[data-subagent-count="3"]')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-subagent-depth]')).toHaveCount(0)
    await app.close()
    app = undefined

    ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox)))
    await waitForInteractive(app, page)
    const restartedFold = row(page, ids.root).locator('[data-subagent-count="3"]')
    await expect(restartedFold).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-subagent-depth]')).toHaveCount(0)
    await restartedFold.click()
    await expect(row(page, ids.beta)).toBeVisible()
    // The nested fold's own open state persists independently.
    await expect(row(page, ids.beta).locator('[data-subagent-count="1"]')).toHaveAttribute('aria-expanded', 'true')
    await expect(row(page, ids.gamma)).toBeVisible()
    await row(page, ids.gamma).getByRole('button', { name: titles.gamma }).click()
    await expect.poll(() => currentSessionId(page)).toBe(ids.gamma)
    await expect(page.locator('[data-slot="aui_thread-viewport"]')).toContainText('Stored transcript for Subagent gamma')
    await screenshot(page, 'restarted-subagent-open')
    expect(provider.completions, 'no LLM calls').toHaveLength(0)
  } finally {
    await app?.close().catch(() => undefined)
    await provider.close()
    sandbox.cleanup()
  }
})
