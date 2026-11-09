/** Attention stimuli run through real tools and real provider accounting, never forged events. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, type Page } from '@playwright/test'

import type { makeScenario } from './subagent-attention.fixture'
export type SubagentKey = 'alpha' | 'beta' | 'gamma'
export const goals = { alpha: 'subagent alpha: inspect files', beta: 'subagent beta: coordinate nested check', gamma: 'grandchild gamma: deep check' }

type Scenario = Awaited<ReturnType<typeof makeScenario>>
export const attentionPolicy = { stuck_after_seconds: 2 }

export function attentionRow(page: Page, subagent: SubagentKey) {
  return page
    .locator('[data-delegate-card] [data-subagent-id]')
    .filter({ hasText: goals[subagent] })
    .filter({ visible: true })
    .first()
}

export async function rolledUp(
  s: Scenario,
  expected: number,
  state: 'waiting' | 'stuck' | 'over_budget' | 'unread' = 'unread'
) {
  const fold = s.page.locator(`[data-slot="sidebar"] [data-session-id="${s.parentId}"] [data-subagent-count]`).first()
  await expect(fold, 'sidebar discovers the real parent child count').toBeVisible({ timeout: 20_000 })
  await expect.soft(fold).toHaveAttribute('aria-expanded', 'false', { timeout: 5_000 })

  if (expected > 0) {
    await expect.soft(fold).toHaveAttribute('data-subagent-attention', state, { timeout: 10_000 })
    await expect
      .soft(fold)
      .toHaveAccessibleName(
        new RegExp(
          `\\b${expected}\\s*·\\s*${state === 'over_budget' ? 'Over budget' : state === 'stuck' ? 'No progress' : state}`,
          'i'
        ),
        { timeout: 10_000 }
      )
  } else {
    await expect.soft(fold).not.toHaveAttribute('data-subagent-attention', /.+/, { timeout: 10_000 })
  }

  await expect.soft(s.page.locator('[data-slot="sidebar"] [data-parent-session-id]:visible')).toHaveCount(0)
}

export async function attentionShown(
  s: Scenario,
  subagent: SubagentKey,
  state: 'waiting' | 'stuck' | 'over_budget' | 'unread'
) {
  const row = attentionRow(s.page, subagent)

  const copy = {
    waiting: /waiting|needs.*(input|approval|answer)/i,
    stuck: /stuck|stalled|no progress/i,
    over_budget: /over.?budget/i,
    unread: /unread|needs.*review/i
  }[state]

  await expect.soft(row).toHaveAttribute('data-subagent-attention', state, { timeout: 15_000 })
  await expect
    .soft(
      row
        .locator('[data-slot="badge"]')
        .filter({ hasText: copy })
        .or(row.getByLabel(copy))
        .or(row.getByTitle(copy))
        .filter({ visible: true })
        .first(),
      `${subagent}: attention badge has a visible or accessible explanation`
    )
    .toBeVisible({ timeout: 5_000 })
}

export function waitingScript(s: Scenario) {
  const victim = path.join(s.sandbox.root, 'approval-victim')
  fs.mkdirSync(victim)
  s.provider.script(s.keys.alpha, [
    {
      text: ['alpha working; needs your decision'],
      toolCalls: [{ name: 'terminal', args: { command: `rm -rf '${victim.replaceAll("'", "'\\''")}'` } }]
    },
    { text: ['alpha decision received'], holdAfterFirstChunk: s.usageGate }
  ])

  return victim
}

export function stalledScript(s: Scenario) {
  // Only alpha stalls. Gamma genuinely keeps streaming through the provider;
  // beta waits on that active child and must not count as a second stalled worker.
  s.provider.script(s.keys.gamma, [{ text: ['gamma progressing', ...Array<string>(4000).fill(' .')] }])
  const started = path.join(s.sandbox.root, 'stuck-started')
  const release = path.join(s.sandbox.root, 'release-stuck')
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  s.provider.script(s.keys.alpha, [
    {
      text: ['alpha working on a stalled tool'],
      toolCalls: [
        {
          name: 'terminal',
          args: {
            command: `printf started > ${quote(started)}; while [ ! -f ${quote(release)} ]; do sleep 0.1; done; printf recovered`,
            timeout: 120
          }
        }
      ]
    },
    { text: ['alpha recovered', ...Array<string>(4000).fill(' .')] }
  ])

  return {
    started,
    recover: () => fs.writeFileSync(release, '')
  }
}
