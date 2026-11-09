import * as fs from 'node:fs'
import * as path from 'node:path'

import { type ElectronApplication, expect, type Page, test } from '@playwright/test'

import {
  appLogTail,
  backendProcesses,
  composer,
  coreAppEnv,
  createCoreSandbox,
  launchCoreApp,
  recordWebSockets,
  send,
  stopSandboxGateway,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { gate, startScriptedProvider } from './provider'

// This exercises the real Electron renderer and gateway with a loopback model.
// Each gate holds one specific child so the stop-scope oracle has a live sibling.
test('live subagent page streams, shows its usage, steers and stops only its child', async () => {
  test.setTimeout(300_000)
  const evidence = process.env.SUBAGENT_PAGE_EVIDENCE ?? test.info().outputPath('evidence')
  fs.mkdirSync(evidence, { recursive: true })
  const provider = await startScriptedProvider({ routing: 'first-user' })
  const sandbox = createCoreSandbox('subagent-page')
  const live = gate()
  const steered = gate()
  const sibling = gate()
  const parent = gate()
  const keys = { parent: 'U1-page', child: 'K11-page', sibling: 'K12-page' }
  const instruction = 'STEER-page use the revised checklist'
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let watch: Page | undefined
  let watchWs: ReturnType<typeof recordWebSockets> | undefined

  try {
    writeProviderHome(
      sandbox.hermesHome,
      provider.url,
      'delegation:\n  max_spawn_depth: 2\n  orchestrator_enabled: true\n  reasoning_effort: high\nmemory:\n  provider: none\n  memory_enabled: false\nsecurity:\n  allow_lazy_installs: false\nfallback_providers: []\n'
    )
    fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled":false}\n')
    expect(JSON.parse(fs.readFileSync(path.join(sandbox.hermesHome, 'honcho.json'), 'utf8')).enabled).toBe(false)
    expect(fs.existsSync(path.join(sandbox.hermesHome, 'auth.json'))).toBe(false)

    provider.script(keys.parent, [
      {
        text: ['Delegating checks.'],
        toolCalls: [
          {
            name: 'delegate_task',
            args: {
              tasks: [
                { goal: `${keys.child} subagent alpha: check files` },
                { goal: `${keys.sibling} subagent beta: check independently` }
              ]
            }
          }
        ]
      },
      { text: ['Parent continued after subagents.'], holdAfterFirstChunk: parent }
    ])
    provider.script(`${keys.parent}~n`, [{ text: ['Parent received results.'] }])
    provider.script(keys.child, [
      {
        text: ['First checkpoint.'],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 60,
          total_tokens: 1260,
          prompt_tokens_details: { cached_tokens: 900 }
        },
        toolCalls: [{ name: 'terminal', args: { command: 'printf page-checkpoint' } }]
      },
      {
        text: ['alpha live streaming from subagent page'],
        holdAfterFirstChunk: live,
        toolCalls: [{ name: 'terminal', args: { command: 'printf page-steer-boundary' } }]
      }
    ])
    provider.script(`${keys.child}~s`, [
      { text: ['alpha received steer and is still working'], holdAfterFirstChunk: steered }
    ])
    provider.script(keys.sibling, [{ text: ['beta remains active'], holdAfterFirstChunk: sibling }])

    ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' })))
    const parentWs = recordWebSockets(page)
    await waitForInteractive(app, page)
    await expect(page.locator('[data-slot="subagent-page-bar"]')).toHaveCount(0)
    await page.screenshot({ path: path.join(evidence, 'parent-no-subagent-bar.png'), animations: 'disabled' })
    await send(page, `${keys.parent} delegate both checks`, 'Enter', parentWs)
    await expect
      .poll(() => provider.completions.some(r => r.marker === keys.child && r.step === 1 && r.sentText), {
        timeout: 90_000
      })
      .toBe(true)
    await expect
      .poll(() => provider.completions.some(r => r.marker === keys.sibling && r.sentText), { timeout: 90_000 })
      .toBe(true)
    const parentPrompts = parentWs.sent.filter(f => f.method === 'prompt.submit').length
    await expect
      .poll(() => provider.completions.some(r => r.marker === keys.parent && r.step >= 1 && r.sentText), {
        timeout: 30_000
      })
      .toBe(true)
    const parentRequest = provider.completions.find(r => r.marker === keys.parent && r.step >= 1)!
    expect(parentRequest.finished, 'the parent is still running independently').toBe(false)
    expect(parentRequest.aborted).toBe(false)
    const card = page.locator('[data-delegate-card] button').filter({ hasText: 'subagent alpha' }).first()
    await expect(card).toBeEnabled({ timeout: 30_000 })
    const opening = app.waitForEvent('window', { timeout: 15_000 })
    await card.click()
    watch = await opening
    watchWs = recordWebSockets(watch)
    const bar = watch.locator('[data-slot="subagent-page-bar"]')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(composer(watch), 'the transcript stays read-only').toHaveCount(0)
    await expect(watch.locator('body')).toContainText('alpha live streaming from subagent page', { timeout: 5_000 })
    const metric = (name: string) => bar.locator(`[data-subagent-metric="${name}"]`)

    for (const name of ['route', 'context', 'cache', 'speed', 'timer']) {
      await expect(metric(name), `${name} is present`).toBeVisible({ timeout: 15_000 })
      await expect(metric(name), `${name} has a value`).not.toHaveText(/^\s*$/)
    }

    await expect(metric('route')).toContainText('mock-model')
    await expect(metric('route')).toContainText(/high/i)
    await expect(metric('cache')).toContainText(/75\s*%/)
    await expect(metric('context')).toContainText(/\d/)
    await expect(metric('speed')).toContainText(/\d+(?:\.\d+)?\s*(?:t\/s|tok\/s|tokens\/s)/i)
    await expect(metric('speed')).not.toContainText(/unavailable|unknown|\bN\/A\b/i)
    // The subagent page shows its diagnostics by default without changing the main statusbar's
    // readout preferences: a fresh profile keeps context / cache / speed off on ordinary chats.
    const mainReadouts = await page.evaluate(() => localStorage.getItem('hermes.desktop.statusbarHidden.v2'))
    const hiddenOnMain: string[] = mainReadouts == null ? [] : JSON.parse(mainReadouts)
    for (const readout of ['context-usage', 'cache-hit-rate', 'tokens-per-second']) {
      expect(mainReadouts == null || hiddenOnMain.includes(readout), `${readout} stays off on the main page`).toBe(
        true
      )
    }
    for (const mode of ['light', 'dark'] as const) {
      await watch.emulateMedia({ colorScheme: mode })
      await watch.screenshot({ path: path.join(evidence, `subagent-live-${mode}.png`), animations: 'disabled' })
    }

    await bar.getByPlaceholder('Instructions for this subagent').fill(instruction)
    await bar.getByRole('button', { name: /steer/i }).click()
    await expect.poll(() => watchWs!.sent.some(f => f.method === 'subagent.steer'), { timeout: 10_000 }).toBe(true)
    live.open()
    await expect
      .poll(
        () =>
          provider.completions.some(
            r => r.marker === `${keys.child}~s` && JSON.stringify(r.body.messages).includes(instruction) && r.sentText
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect(
      watch.locator('[data-subagent-steer]').filter({ hasText: instruction }).first(),
      'the delivered steer is visible in the transcript'
    ).toBeVisible({ timeout: 15_000 })
    await watch.screenshot({ path: path.join(evidence, 'subagent-steered.png'), animations: 'disabled' })
    await bar.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => watchWs!.sent.some(f => f.method === 'subagent.interrupt'), { timeout: 10_000 }).toBe(true)
    await expect
      .poll(() => provider.completions.some(r => r.marker === `${keys.child}~s` && r.aborted), { timeout: 30_000 })
      .toBe(true)
    const siblingRequest = provider.completions.find(r => r.marker === keys.sibling)!
    expect(siblingRequest.aborted, 'stopping alpha must not abort beta').toBe(false)
    expect(siblingRequest.finished, 'beta is still held when alpha is stopped').toBe(false)
    expect(parentWs.sent.filter(f => f.method === 'prompt.submit')).toHaveLength(parentPrompts)
    expect(parentRequest.aborted, 'stopping alpha did not abort the parent turn').toBe(false)
    expect(parentRequest.finished, 'the parent is still held when alpha is stopped').toBe(false)
    sibling.open()
    parent.open()
    await expect.poll(() => siblingRequest.finished, { timeout: 30_000 }).toBe(true)
    await expect.poll(() => parentRequest.finished, { timeout: 30_000 }).toBe(true)
    const childId = await bar.getAttribute('data-session-id')
    expect(childId).toBeTruthy()
    await watch.close()
    watch = undefined
    await page.evaluate(id => {
      location.hash = `#/${id}`
    }, childId)
    const fullBar = page.locator('[data-slot="subagent-page-bar"]')
    await expect(fullBar).toBeVisible({ timeout: 15_000 })
    await expect(fullBar).toContainText('Subagent finished')
    await expect(fullBar.locator('[data-subagent-metric="route"]')).toContainText('mock-model')
    // The durable steer is the user's own row in the child transcript (as a main-chat steer is after
    // reload), in the user's words, never the model-facing marker.
    const steerRow = page.locator('[data-role="user"]').filter({ visible: true }).filter({ hasText: instruction })
    await expect(steerRow.first()).toBeVisible()
    await expect(steerRow.first()).not.toContainText('OUT-OF-BAND')
    await expect(composer(page)).toHaveCount(0)
    await page.reload()
    await expect(fullBar).toContainText('Subagent finished', { timeout: 15_000 })
    await expect(fullBar.locator('[data-subagent-metric="cache"]')).toContainText('75%')
    const requestsBeforeRestart = provider.completions.length
    await app.close()
    expect(stopSandboxGateway(sandbox, { interrupt: true }).code).toBe(0)
    await expect.poll(() => backendProcesses(sandbox)).toHaveLength(0)
    ;({ app, page } = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' })))
    await page.evaluate(id => { location.hash = `#/${id}` }, childId)
    const recovered = page.locator('[data-slot="subagent-page-bar"]').filter({ visible: true }).first()
    await expect(recovered).toContainText('Subagent finished', { timeout: 30_000 })
    await expect(recovered.locator('[data-subagent-metric="cache"]')).toContainText('75%')
    await expect(recovered.locator('[data-subagent-metric="route"]')).toContainText('mock-model')
    await expect(composer(page)).toHaveCount(0)
    expect(provider.completions.length, 'reopening the stored page performs no inference').toBe(requestsBeforeRestart)
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode })
      await page.screenshot({ path: path.join(evidence, `subagent-finished-${mode}.png`), animations: 'disabled' })
    }
  } finally {
    const records = provider.completions.map(r => ({
      marker: r.marker,
      step: r.step,
      model: r.model,
      effort: r.effort,
      sentText: r.sentText,
      finished: r.finished,
      aborted: r.aborted,
      toolCalls: r.toolCalls,
      containsSteer: JSON.stringify(r.body.messages ?? []).includes(instruction)
    }))

    fs.writeFileSync(path.join(evidence, 'provider-records.json'), JSON.stringify(records, null, 2))

    if (app) {
      fs.writeFileSync(path.join(evidence, 'app.log'), appLogTail(app, 200))
    }

    const logs = path.join(sandbox.hermesHome, 'logs')

    if (fs.existsSync(logs)) {
      fs.cpSync(logs, path.join(evidence, 'sandbox-logs'), { recursive: true })
    }

    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'parent-last.png'), animations: 'disabled' }).catch(() => {})
    }

    if (watchWs) {
      fs.writeFileSync(path.join(evidence, 'watch-rpc.json'), JSON.stringify(watchWs.sent, null, 2))
    }

    if (watch && !watch.isClosed()) {
      await watch.screenshot({ path: path.join(evidence, 'subagent-last.png'), animations: 'disabled' }).catch(() => {})
    }

    live.open()
    steered.open()
    sibling.open()
    parent.open()

    try {
      if (app) {
        await app.close()
      }
    } finally {
      await provider.close()
      sandbox.cleanup()
    }
  }
})
