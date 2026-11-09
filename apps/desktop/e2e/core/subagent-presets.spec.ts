/**
 * Settings › Model › Subagents › Presets against a real local gateway: a saved preset and the default
 * for new chats are written to the profile's library and are still there after a renderer reload.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { coreAppEnv, createCoreSandbox, launchCoreApp, waitForInteractive, writeProviderHome } from './harness'
import { startScriptedProvider } from './provider'

const SUBAGENTS_PAGE = '#/settings?tab=config%3Amodel&page=delegation'

async function openPresets(page: Page) {
  await page.evaluate(hash => (location.hash = hash), SUBAGENTS_PAGE)
  const section = page.getByText('Subagent presets', { exact: true })
  await expect(section).toBeVisible({ timeout: 60_000 })
  await section.scrollIntoViewIfNeeded()
}

test('a saved subagent preset and default survive a reload', async () => {
  test.setTimeout(300_000)
  const provider = await startScriptedProvider()
  const box = createCoreSandbox('subagent-presets')
  writeProviderHome(box.hermesHome, provider.url)
  const library = path.join(box.hermesHome, 'subagent-presets.json')
  const { app, page } = await launchCoreApp(coreAppEnv(box))

  try {
    await waitForInteractive(app, page)
    await openPresets(page)
    await expect(page.getByText('No presets yet.')).toBeVisible()

    await page.getByRole('textbox', { name: 'Preset name', exact: true }).fill('research team')
    await page.getByRole('button', { name: 'Save current settings' }).click()
    await expect(page.getByRole('textbox', { name: 'Preset name: research team' })).toBeVisible()

    await page.getByRole('combobox', { name: 'Default for new chats' }).click()
    await page.getByRole('option', { name: 'research team' }).click()
    await expect(page.getByRole('combobox', { name: 'Default for new chats' })).toContainText('research team')

    const saved = JSON.parse(fs.readFileSync(library, 'utf8'))
    expect(Object.keys(saved.presets)).toEqual(['research team'])
    expect(saved.default_preset).toBe('research team')
    await page.screenshot({ path: test.info().outputPath('subagent-presets-settings.png') })

    await page.reload() // the renderer reopens on the same Settings page
    await openPresets(page)
    await expect(page.getByRole('textbox', { name: 'Preset name: research team' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Default for new chats' })).toContainText('research team')
  } finally {
    await app.close().catch(() => undefined)
    await provider.close()
  }
})
