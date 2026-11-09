import * as fs from 'node:fs'

import type { Page } from '@playwright/test'

import { composer } from './harness'
import type { makeScenario } from './subagent-attention.fixture';
import { expect, test } from './subagent-attention.fixture'
import { attentionPolicy, attentionRow, attentionShown, goals, rolledUp, stalledScript, type SubagentKey, waitingScript } from './subagent-ux.attention'

const agentRow = (page: Page, key: SubagentKey) => page.locator('[data-subagent-id]').filter({ hasText: goals[key] }).filter({ visible: true }).last()

async function parent(s: Awaited<ReturnType<typeof makeScenario>>) {
  await s.page.locator(`[data-slot="sidebar"] [data-session-id="${s.parentId}"] [data-slot="row-button"]`).first().click()
  await expect(attentionRow(s.page, 'alpha')).toBeVisible()
}

async function openAlpha(s: Awaited<ReturnType<typeof makeScenario>>) {
  await s.page.locator('[data-delegate-card] button').filter({ hasText: goals.alpha }).filter({ visible: true }).first().click()
  await expect(s.page.locator('[data-slot="subagent-page-bar"]').filter({ visible: true })).toContainText('Subagent finished')
  await expect(s.page.locator('[data-slot="aui_user-message-root"]').filter({ visible: true })).toContainText(goals.alpha)
}

test('D — finished-unread rolls through a folded parent and clears only the opened subagent', async ({ scenario: s }) => {
  await s.start()
  const route = s.page.url()
  await composer(s.page).fill('keep my draft')
  await composer(s.page).focus()
  await s.finish()
  expect(s.page.url(), 'completion does not navigate').toBe(route)
  await expect(composer(s.page), 'completion preserves focus').toBeFocused()
  await expect(composer(s.page)).toContainText('keep my draft')
  await attentionShown(s, 'alpha', 'unread')
  await rolledUp(s, 3)
  await openAlpha(s)
  await parent(s)
  await expect.soft(attentionRow(s.page, 'alpha')).not.toHaveAttribute('data-subagent-attention', 'unread')
  await expect.soft(attentionRow(s.page, 'beta')).toHaveAttribute('data-subagent-attention', 'unread')
  await rolledUp(s, 2)
  await s.page.reload()
  await expect.soft(attentionRow(s.page, 'alpha')).not.toHaveAttribute('data-subagent-attention', 'unread')
  await rolledUp(s, 2)
})

// Clarify is deliberately not a child tool. Exercise both answers to the real,
// parent-owned child approval prompt instead of inventing a child clarification UI.
for (const decision of ['approve', 'deny'] as const) {
  test.describe(`D — waiting for approval (${decision})`, () => {
    test.use({ scenarioOptions: { approvals: 'manual', holdParentTurn: true } })
    test('a real child decision raises attention and answering clears it without a parent turn', async ({
      scenario: s
    }) => {
      const victim = waitingScript(s)
      await s.start()
      const initialPrompts = s.promptCount()
      const route = s.page.url()
      expect(s.provider.completions.some(r => r.marker === s.keys.alpha && r.toolCalls.includes('terminal'))).toBe(true)
      expect(fs.existsSync(victim), 'command cannot run before approval').toBe(true)
      await attentionShown(s, 'alpha', 'waiting')
      await rolledUp(s, 1, 'waiting')
      expect(s.page.url()).toBe(route)

      // The approval belongs to the parent's execution generation; responding in
      // that existing UI is not asking its agent or submitting another prompt.
      const action = s.page
        .locator(decision === 'approve' ? '[data-approval-run]' : '[data-approval-deny]')
        .filter({ visible: true })

      await expect(action).toHaveCount(1)
      await action.click()
      await expect.poll(() => s.provider.completions.some(r => r.marker === s.keys.alpha && r.step === 1)).toBe(true)

      if (decision === 'approve') {
        await expect.poll(() => fs.existsSync(victim)).toBe(false)
      } else {
        expect(fs.existsSync(victim), 'denied command never executed').toBe(true)
        const next = s.provider.completions.find(r => r.marker === s.keys.alpha && r.step === 1)!
        expect(JSON.stringify(next.body.messages.filter((m: any) => m.role === 'tool'))).toMatch(
          /denied|rejected|not approved/i
        )
      }

      await expect.soft(attentionRow(s.page, 'alpha')).not.toHaveAttribute('data-subagent-attention', 'waiting')
      await rolledUp(s, 0)
      expect(s.promptCount()).toBe(initialPrompts)
    })
  })
}

test.describe('D — stalled tool', () => {
  test.use({ scenarioOptions: { attention: attentionPolicy } })
  test('real inactivity is flagged without navigating, and progress clears the flag', async ({ scenario: s }) => {
    const stalled = stalledScript(s)
    await s.start()
    await expect.poll(() => fs.existsSync(stalled.started)).toBe(true)
    const route = s.page.url()
    await attentionShown(s, 'alpha', 'stuck')
    await rolledUp(s, 1, 'stuck')
    expect(s.page.url()).toBe(route)
    stalled.recover()
    await expect.poll(() => s.provider.completions.some(r => r.marker === s.keys.alpha && r.step === 1)).toBe(true)
    await expect.soft(attentionRow(s.page, 'alpha')).not.toHaveAttribute('data-subagent-attention', 'stuck')
    await rolledUp(s, 0)
  })
})

test.describe('D — actual iteration budget exhaustion', () => {
  test.use({ scenarioOptions: { maxIterations: 2 } })
  test('the child exhausting its configured work budget raises attention without falsely flagging siblings', async ({
    scenario: s
  }) => {
    s.provider.script(s.keys.alpha, [
      {
        text: ['alpha working first iteration'],
        toolCalls: [{ name: 'terminal', args: { command: 'printf budget-one' } }]
      },
      {
        text: ['alpha working second iteration'],
        toolCalls: [{ name: 'terminal', args: { command: 'printf budget-two' } }]
      },
      { text: ['alpha forced summary after budget exhaustion'] }
    ])
    await s.start()
    const route = s.page.url()
    await expect
      .configure({ soft: true })
      .poll(() => s.rows().find(r => r.id === s.childId('alpha'))?.end_reason, { timeout: 5_000 })
      .toBe('subagent_max_iterations')
    expect(s.provider.completions.filter(r => r.marker === s.keys.alpha && r.toolCalls.includes('terminal'))).toHaveLength(2)
    await attentionShown(s, 'alpha', 'over_budget')
    await expect.soft(attentionRow(s.page, 'beta')).not.toHaveAttribute('data-subagent-attention', 'over_budget')
    await rolledUp(s, 1, 'over_budget')
    expect(s.page.url()).toBe(route)
    await s.page.evaluate(() => {
      location.hash = '#/agents'
    })
    await expect.soft(agentRow(s.page, 'alpha')).toContainText(/over.?budget/i, { timeout: 5_000 })
    expect(s.promptCount()).toBe(1)
  })
})
