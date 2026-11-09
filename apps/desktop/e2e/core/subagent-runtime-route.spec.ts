/**
 * Agents rows show the route a subagent actually ran on: provider · model · effort,
 * plus Fallback when its configured route failed and the backend's fallback took over.
 *
 * Real Electron + backend; the scripted provider serves separate named routes and
 * records the reasoning effort the backend really sent. Nothing seeds UI stores.
 * The subagent is held mid-stream so its row is live in the Agents view.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import {
  coreAppEnv,
  createCoreSandbox,
  launchCoreApp,
  recordWebSockets,
  send,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { gate, type ScriptedProvider, startScriptedProvider } from './provider'

const nonce = Math.random()
  .toString(36)
  .slice(2, 8)
  .replace(/[^a-z0-9]/g, 'x')
  .padEnd(4, 'q')

interface Case {
  route: 'worker' | 'broken'
  effort?: 'high' | 'none'
}

function routeConfig(provider: ScriptedProvider, c: Case): string {
  const named = Object.entries(provider.routes)
    .map(
      ([name, r]) =>
        `  ${name}:\n    api: ${r.url}/v1\n    api_mode: chat_completions\n    key_env: MOCK_API_KEY\n` +
        `    context_length: 64000\n    models:\n      ${r.model}: {}`
    )
    .join('\n')

  const fallback = c.route === 'broken' ? '\n    - provider: rescue\n      model: fallback-model' : ' []'

  return (
    `model:\n  default: parent-model\n  provider: parent\nproviders:\n${named}\n` +
    `auxiliary:\n  title_generation:\n    enabled: false\nagent:\n  api_max_retries: 1\napprovals:\n  mode: off\n` +
    `memory:\n  provider: none\n  memory_enabled: false\nsecurity:\n  allow_lazy_installs: false\n` +
    `fallback_providers: []\ndelegation:\n  provider: ${c.route}\n  model: ${provider.routes[c.route].model}\n` +
    `${c.effort ? `  reasoning_effort: ${c.effort}\n` : ''}  fallback_providers:${fallback}\n`
  )
}

/** The Agents row of the subagent whose goal names `marker` (not the chat's delegate card). */
function agentRow(page: Page, marker: string) {
  return page
    .locator('[data-slot="tool-block"]:not([data-delegate-card])')
    .filter({ hasText: `${marker} subagent` })
    .filter({ visible: true })
    .last()
}

/** Opt-in evidence: light and dark captures of the Agents view (HERMES_E2E_ROUTE_SCREENSHOT_DIR). */
async function capture(page: Page, name: string) {
  const dir = process.env.HERMES_E2E_ROUTE_SCREENSHOT_DIR

  if (!dir) {
    return
  }

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(400)
    await page.screenshot({ animations: 'disabled', path: path.join(dir, `agents-route-${name}-${scheme}.png`) })
  }
}

async function runOneSubagent(c: Case, label: string) {
  const provider = await startScriptedProvider({
    routes: {
      parent: { model: 'parent-model' },
      worker: { model: 'subagent-model' },
      broken: { model: 'failed-model', httpStatus: 503 },
      rescue: { model: 'fallback-model' }
    }
  })

  const sandbox = createCoreSandbox(`subagent-route-${label}`)
  writeProviderHome(sandbox.hermesHome, provider.url)
  fs.writeFileSync(path.join(sandbox.hermesHome, 'config.yaml'), routeConfig(provider, c))
  fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled":false}\n')
  const parentMarker = `U1-${label}${nonce}`
  const childMarker = `U2-${label}${nonce}`
  provider.script(parentMarker, [
    {
      text: ['Delegating.'],
      toolCalls: [{ name: 'delegate_task', args: { goal: `${childMarker} subagent: report the route` } }]
    },
    { text: ['Subagent finished.'] }
  ])
  const hold = gate()
  // One tool call first, like a real subagent: its progress event carries the route the backend
  // observed on that request. The second completion is then held so the row stays live.
  provider.script(childMarker, [
    { text: ['checking '], toolCalls: [{ name: 'terminal', args: { command: 'printf route-check' } }] },
    { text: ['route ', 'reported'], holdAfterFirstChunk: hold }
  ])
  const { app, page } = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' }))
  const ws = recordWebSockets(page)

  const close = async () => {
    hold.open()
    await app.close().catch(() => {})
    await provider.close()
    sandbox.cleanup()
  }

  try {
    await waitForInteractive(app, page)
    await send(page, `${parentMarker} delegate one check`, 'Enter', ws)
    await provider.streamStarted(childMarker, 1)
    await page.evaluate(() => {
      location.hash = '#/agents'
    })

    return { provider, page, row: agentRow(page, childMarker), childMarker, close }
  } catch (error) {
    await close()
    throw error
  }
}

test('actual fallback: the row names the fallback provider and model, not the failed launch route', async () => {
  const s = await runOneSubagent({ route: 'broken', effort: 'high' }, 'fb')

  try {
    const calls = s.provider.completions.filter(r => r.marker === s.childMarker)
    expect(calls.some(r => r.route === 'broken' && r.httpStatus === 503)).toBe(true)
    const rescue = calls.find(r => r.route === 'rescue' && r.httpStatus === 200)
    expect(rescue, 'the fallback route answered').toBeTruthy()
    const sent = calls.map(r => `${r.route}:${r.effort}`).join(', ')
    test.info().annotations.push({ type: 'wire effort', description: sent })
    console.log(`wire effort per request: ${sent}`)
    await expect(s.row).toContainText('fallback-model')
    const routeText = (await s.row.innerText()).replaceAll('fallback-model', '')
    expect(routeText, 'actual provider is separate from the model').toMatch(/\brescue\b/)
    expect(routeText, 'fallback badge is separate from model/provider').toMatch(/\bfallback\b/i)
    expect(routeText, `effort shown is what the fallback request carried (${sent})`).toContain(
      rescue!.effort ?? 'Effort unknown'
    )
    await expect(s.row).not.toContainText('failed-model')
    await capture(s.page, 'fallback')
  } finally {
    await s.close()
  }
})

test('explicit reasoning disabled reads as off, not unknown or an inherited level', async () => {
  const s = await runOneSubagent({ route: 'worker', effort: 'none' }, 'off')

  try {
    expect(s.provider.completions.find(r => r.marker === s.childMarker)!.effort).toBe('none')
    await expect(s.row).toContainText('worker · subagent-model · Reasoning off')
    await expect(s.row).not.toContainText(/unknown/i)
  } finally {
    await s.close()
  }
})

test('unset effort shows what the wire actually carried, marked as a default', async () => {
  const s = await runOneSubagent({ route: 'worker' }, 'unset')

  try {
    const wire = s.provider.completions.find(r => r.marker === s.childMarker)!
    await expect(s.row).toContainText('worker · subagent-model')

    if (wire.effort === null) {
      await expect(s.row).toContainText('Effort unknown')
      await expect(s.row).not.toContainText(/reasoning off/i)
    } else {
      await expect(s.row).toContainText(`${wire.effort} (default)`)
    }

    await capture(s.page, 'default')
  } finally {
    await s.close()
  }
})
