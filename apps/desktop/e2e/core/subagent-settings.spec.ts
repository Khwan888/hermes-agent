/**
 * Per-chat subagent settings from the typing bar's model picker, against a real local gateway and real
 * subagents. Three loopback providers stand in for the parent route and two subagent routes, so every
 * assertion reads the provider that actually received a subagent's request.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import {
  coreAppEnv,
  createCoreSandbox,
  currentSessionId,
  launchCoreApp,
  send,
  storedSessionForMarker,
  waitForInteractive,
  writeProviderHome
} from './harness'
import { type ScriptedProvider, startScriptedProvider } from './provider'

type Routes = Record<'parent' | 'worker' | 'rescue', ScriptedProvider>

const MODELS = { parent: 'parent-model', worker: 'subagent-model', rescue: 'fallback-model' }

// Profile default for subagents: worker/subagent-model, depth 2 (a subagent may delegate once more).
function profileConfig(routes: Routes): string {
  const providers = Object.entries(routes)
    .map(
      ([name, provider]) =>
        `  ${name}:\n    api: ${provider.url}/v1\n    api_mode: chat_completions\n    key_env: MOCK_API_KEY\n` +
        `    context_length: 64000\n    models:\n      ${MODELS[name as keyof Routes]}: {}`
    )
    .join('\n')

  return `model:\n  default: parent-model\n  provider: parent\nproviders:\n${providers}\nauxiliary:\n  title_generation:\n    enabled: false\napprovals:\n  mode: off\nmemory:\n  provider: none\n  memory_enabled: false\nsecurity:\n  allow_lazy_installs: false\nfallback_providers: []\ndelegation:\n  max_spawn_depth: 2\n  orchestrator_enabled: true\n  provider: worker\n  model: subagent-model\n  fallback_providers: []\n`
}

const pill = (page: Page) => page.locator('[data-tour="model-pill"]').filter({ visible: true }).first()
const marker = (page: Page) => page.getByTestId('subagent-settings-marker').filter({ visible: true })

async function openEditor(page: Page) {
  await pill(page).click()
  const row = page.getByRole('menuitem', { name: /^Subagents$/ })

  if ((await row.getAttribute('aria-haspopup')) === 'menu') {
    await row.hover()
    await page.getByRole('menuitem', { name: 'Edit for this chat…' }).click()
  } else {
    await row.click()
  }

  const dialog = page.getByRole('dialog', { name: 'Subagents for this chat' })
  await expect(dialog).toBeVisible()

  return dialog
}

async function shot(page: Page, name: string) {
  const dir = process.env.SUBAGENT_SETTINGS_SHOTS

  if (!dir) {
    return
  }

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(dir, `${name}-${scheme}.png`) })
  }

  await page.emulateMedia({ colorScheme: 'light' })
}

test('per-chat subagent settings drive real subagents, stay in their chat, and survive reload', async () => {
  test.setTimeout(480_000)

  const routes: Routes = {
    parent: await startScriptedProvider(),
    worker: await startScriptedProvider(),
    rescue: await startScriptedProvider()
  }

  const box = createCoreSandbox('subagent-settings')
  writeProviderHome(box.hermesHome, routes.parent.url)
  fs.writeFileSync(path.join(box.hermesHome, 'config.yaml'), profileConfig(routes))
  const { app, page } = await launchCoreApp(coreAppEnv(box, { HERMES_DISABLE_LAZY_INSTALLS: '1' }))

  // Which route answered a subagent, and whether that subagent was itself offered delegate_task.
  const childOn = (key: string) => {
    for (const name of ['worker', 'rescue', 'parent'] as const) {
      const rec = routes[name].completions.find(r => r.marker === key)

      if (rec) {
        const nested = (rec.body.tools ?? []).some((t: any) => t.function?.name === 'delegate_task')

        return { route: name, model: rec.body.model as string, nested }
      }
    }

    return null
  }

  const turn = (parent: string, child: string, done: string) => {
    routes.parent.script(parent, [
      { text: ['Delegating.'], toolCalls: [{ name: 'delegate_task', args: { goal: `${child} inspect one file` } }] },
      { text: [done] }
    ])
    // Delegation finishes in the background: its completion notice starts one more parent turn whose
    // newest user message names the child. Answer it, so the next prompt never races that turn.
    routes.parent.script(child, [{ text: [`Noted ${child}.`] }])

    for (const route of [routes.worker, routes.rescue]) {
      route.script(child, [{ text: [`${child} finished`] }])
    }
  }

  const expectChild = async (key: string, route: 'rescue' | 'worker', nested: boolean, done: string) => {
    await expect.poll(() => childOn(key), { timeout: 120_000 }).not.toBeNull()
    expect(childOn(key)).toEqual({ route, model: MODELS[route], nested })
    const thread = page.locator('[data-slot="aui_thread-viewport"]')
    await expect(thread).toContainText(done, { timeout: 120_000 })
    await expect(thread).toContainText(`Noted ${key}.`, { timeout: 120_000 })
  }

  turn('U31-first', 'U41-first', 'First chat done.')
  turn('U32-second', 'U42-second', 'Second chat done.')
  turn('U33-reloaded', 'U43-reloaded', 'Reloaded chat done.')
  turn('U34-preset', 'U44-preset', 'Preset chat done.')
  turn('U35-persisted', 'U45-persisted', 'Persisted preset done.')

  try {
    await waitForInteractive(app, page)
    // The profile config after boot; nothing below may write it (every choice is per chat).
    const configPath = path.join(box.hermesHome, 'config.yaml')
    const profileAtBoot = fs.readFileSync(configPath, 'utf8')

    // Untouched: the pill carries no marker and the Subagents row is a plain footer item.
    await expect(marker(page)).toHaveCount(0)
    await pill(page).click()
    await expect(page.getByRole('menuitem', { name: /^Subagents$/ })).toBeVisible()
    await shot(page, 'model-menu-subagents-row')
    await page.keyboard.press('Escape')

    // Draft first-create: choose the rescue route and depth 1 before the chat exists.
    const draft = await openEditor(page)
    await draft.locator('#subagent-provider').click()
    await page.getByRole('option', { name: /^rescue$/i }).click()
    await draft.getByRole('combobox', { name: 'Subagent Model', exact: true }).click()
    await page.getByRole('option', { name: 'fallback-model', exact: true }).click()
    await draft.getByRole('spinbutton', { name: 'Nesting depth' }).fill('1')
    await shot(page, 'subagent-settings-dialog')
    await draft.getByRole('button', { name: 'Apply to this chat', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(draft).toBeHidden()
    await expect(marker(page)).toHaveCount(1)

    await send(page, 'U31-first run one check')
    await expectChild('U41-first', 'rescue', false, 'First chat done.')
    await expect.poll(() => storedSessionForMarker(box, 'default', 'U31-first')).toBeTruthy()
    const chatA = storedSessionForMarker(box, 'default', 'U31-first')!
    await expect(marker(page)).toHaveCount(1)
    await shot(page, 'model-pill-override-marker')

    // A second chat starts on the profile defaults: no marker, worker route, nested delegation allowed.
    await page.evaluate(() => (location.hash = '#/'))
    await expect.poll(() => currentSessionId(page)).toBe('')
    await expect(marker(page)).toHaveCount(0)
    await send(page, 'U32-second run one check')
    await expectChild('U42-second', 'worker', true, 'Second chat done.')
    expect(storedSessionForMarker(box, 'default', 'U32-second')).not.toBe(chatA)
    await expect(marker(page)).toHaveCount(0)

    // Save this chat's (profile-default) settings as a named preset.
    const save = await openEditor(page)
    await save.getByRole('textbox', { name: 'Preset name' }).fill('Team default')
    await save.getByRole('button', { name: 'Save current as preset' }).click()
    await expect(save.getByRole('button', { name: 'Team default', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(save).toBeHidden()

    // Reload the first chat: its override is still in force for the next real subagent.
    await page.evaluate(id => (location.hash = `#/${encodeURIComponent(id)}`), chatA)
    await expect.poll(() => currentSessionId(page)).toBe(chatA)
    await page.reload()
    await waitForInteractive(app, page)
    await expect.poll(() => currentSessionId(page)).toBe(chatA)
    await expect(marker(page)).toHaveCount(1)
    await send(page, 'U33-reloaded run one check')
    await expectChild('U43-reloaded', 'rescue', false, 'Reloaded chat done.')

    // Pick the preset for this chat from the model picker's Subagents submenu.
    await pill(page).click()
    const row = page.getByRole('menuitem', { name: /^Subagents$/ })
    await expect(row).toHaveAttribute('aria-haspopup', 'menu')
    await row.hover()
    const preset = page.getByRole('menuitem', { name: 'Team default' })
    await expect(preset).toBeVisible()
    await shot(page, 'model-menu-subagents-presets')
    await preset.click()
    // The preset equals the profile defaults, so the chat is back to a quiet pill.
    await expect(marker(page)).toHaveCount(0)
    await send(page, 'U34-preset run one check')
    await expectChild('U44-preset', 'worker', true, 'Preset chat done.')

    await page.reload()
    await waitForInteractive(app, page)
    await expect.poll(() => currentSessionId(page)).toBe(chatA)
    await send(page, 'U35-persisted run one check')
    await expectChild('U45-persisted', 'worker', true, 'Persisted preset done.')
    expect(JSON.parse(fs.readFileSync(path.join(box.hermesHome, 'subagent-presets.json'), 'utf8')).presets).toHaveProperty(
      'Team default'
    )
    expect(fs.readFileSync(configPath, 'utf8')).toBe(profileAtBoot)
  } finally {
    await app.close().catch(() => undefined)
    await Promise.all(Object.values(routes).map(route => route.close()))
  }
})
