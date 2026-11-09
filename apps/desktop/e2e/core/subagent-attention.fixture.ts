/** Attention-only real Electron/backend fixture; no synthetic events or store writes. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { test as coreTest, expect } from '@playwright/test'

import { coreAppEnv, createCoreSandbox, launchCoreApp, recordWebSockets, send, storedSessionForMarker, waitForInteractive, writeProviderHome } from './harness'
import { gate, startScriptedProvider } from './provider'

interface ScenarioOptions {
  approvals?: 'manual' | 'off'
  attention?: { stuck_after_seconds: number }
  maxIterations?: number
  holdParent?: boolean
  holdParentTurn?: boolean
}

export async function makeScenario(options: ScenarioOptions = {}) {
  const provider = await startScriptedProvider({ routing: 'first-user' })
  const sandbox = createCoreSandbox('subagent-attention')
  writeProviderHome(sandbox.hermesHome, provider.url,
    `delegation:\n  max_spawn_depth: 2\n  orchestrator_enabled: true\n${options.maxIterations ? `  max_iterations: ${options.maxIterations}\n` : ''}${options.attention ? `  stuck_after_seconds: ${options.attention.stuck_after_seconds}\n` : ''}memory:\n  provider: none\n  memory_enabled: false\nsecurity:\n  allow_lazy_installs: false\nfallback_providers: []\n`, options.approvals ?? 'off')
  fs.writeFileSync(path.join(sandbox.hermesHome, 'honcho.json'), '{"enabled":false}\n')
  const gates = [gate(), gate(), gate()]
  const usageGate = gate()
  const parentGate = gate()
  const parentTurnGate = gate()
  const keys = { parent: 'U1-attention', alpha: 'K11-attention', beta: 'K12-attention', gamma: 'K13-attention' }
  provider.script(keys.parent, [
    {
      text: ['Delegating.'],
      ...(options.holdParent ? { holdAfterFirstChunk: parentGate } : {}),
      toolCalls: [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              { goal: `${keys.alpha} subagent alpha: inspect files` },
              { goal: `${keys.beta} subagent beta: coordinate nested check` }
            ]
          }
        }
      ]
    },
    { text: ['Subagents dispatched.'], ...(options.holdParentTurn ? { holdAfterFirstChunk: parentTurnGate } : {}) }
  ])
  provider.script(`${keys.parent}~n`, [{ text: ['Results received.'] }])
  provider.script(keys.alpha, [
    {
      text: ['alpha working ', 'checkpoint'],
      holdAfterFirstChunk: gates[0],
      toolCalls: [{ name: 'terminal', args: { command: 'printf alpha-checkpoint' } }]
    },
    { text: ['alpha final'], holdAfterFirstChunk: usageGate }
  ])
  provider.script(`${keys.alpha}~s`, [{ text: ['alpha steered final'] }])
  provider.script(keys.beta, [
    {
      text: ['beta delegating'],
      toolCalls: [{ name: 'delegate_task', args: { goal: `${keys.gamma} grandchild gamma: deep check` } }]
    },
    { text: ['beta survived ', 'gamma'], holdAfterFirstChunk: gates[1] }
  ])
  provider.script(keys.gamma, [{ text: ['gamma working ', 'final'], holdAfterFirstChunk: gates[2] }])

  const launched = await launchCoreApp(coreAppEnv(sandbox, { HERMES_DISABLE_LAZY_INSTALLS: '1' }))
  const ws = recordWebSockets(launched.page)
  let parentId = ''

  const scenario = {
    provider,
    sandbox,
    gates,
    keys,
    usageGate,
    childId(subagent: 'alpha' | 'beta' | 'gamma') {
      const id = storedSessionForMarker(sandbox, 'default', keys[subagent])
      expect(id, `${subagent} has a persisted child session`).toBeTruthy()

      return id!
    },
    promptCount() {
      return ws.sent.filter(f => f.method === 'prompt.submit').length
    },
    get ws() {
      return ws
    },
    get app() {
      return launched.app
    },
    get page() {
      return launched.page
    },
    get parentId() {
      return parentId
    },
    async begin() {
      await waitForInteractive(launched.app, launched.page)
      await send(launched.page, `${keys.parent} delegate the checks`, 'Enter', ws)
      await expect.poll(() => provider.completions.some(r => r.marker === keys.parent), { timeout: 90_000 }).toBe(true)
      await expect.poll(() => storedSessionForMarker(sandbox, 'default', keys.parent)).toBeTruthy()
      parentId = storedSessionForMarker(sandbox, 'default', keys.parent) ?? ''
    },
    async continueStart() {
      parentGate.open()
      await expect.poll(() => provider.completions.some(r => r.marker === keys.gamma), { timeout: 90_000 }).toBe(true)
      parentId = storedSessionForMarker(sandbox, 'default', keys.parent) ?? ''
      expect(parentId, 'backend persisted the parent identity').not.toBe('')
      await expect(launched.page.locator('[data-delegate-card]')).toBeVisible()
    },
    async start() {
      await scenario.begin()
      await scenario.continueStart()
    },
    async finish() {
      expect(
        scenario.rows().filter(r => r.parent_session_id),
        'all three real subagents exist before completion'
      ).toHaveLength(3)
      fs.writeFileSync(path.join(sandbox.root, 'release-stuck'), '')
      gates.forEach(g => g.open())
      usageGate.open()
      await expect
        .poll(
          () =>
            provider.completions
              .filter(r => [keys.alpha, keys.beta, keys.gamma].includes(r.marker ?? ''))
              .every(r => r.finished || r.aborted),
          { timeout: 90_000 }
        )
        .toBe(true)
      await expect
        .poll(
          () =>
            scenario
              .rows()
              .filter(r => r.parent_session_id)
              .every(r => r.ended_at !== null),
          { timeout: 90_000 }
        )
        .toBe(true)
    },
    rows(): Array<{
      id: string
      parent_session_id: string | null
      ended_at: number | null
      end_reason: string | null
      model_config: string | null
    }> {
      const db = new DatabaseSync(path.join(sandbox.hermesHome, 'state.db'), { readOnly: true })

      try {
        return db
          .prepare('SELECT id, parent_session_id, ended_at, end_reason, model_config FROM sessions')
          .all() as ReturnType<typeof scenario.rows>
      } finally {
        db.close()
      }
    },
    async dispose() {
      fs.writeFileSync(path.join(sandbox.root, 'release-stuck'), '')
      gates.forEach(g => g.open())
      usageGate.open()
      parentGate.open()
      parentTurnGate.open()

      try {
        await launched.app.close()
      } finally {
        await provider.close()
        sandbox.cleanup()
      }
    }
  }

  return scenario
}

export const test = coreTest.extend<{
  scenarioOptions: ScenarioOptions
  scenario: Awaited<ReturnType<typeof makeScenario>>
}>({
  scenarioOptions: [{}, { option: true }],
  // Playwright requires object destructuring in fixture signatures.

  scenario: async ({ scenarioOptions }, runFixture, info) => {
    const scenario = await makeScenario(scenarioOptions)

    try {
      await runFixture(scenario)
    } finally {
      try {
        await info.attach('provider-routing', {
          body: JSON.stringify(
            scenario.provider.completions.map(r => ({
              key: r.marker,
              step: r.step,
              finished: r.finished,
              aborted: r.aborted,
              model: r.body.model,
              route: r.route,
              effort: r.effort,
              httpStatus: r.httpStatus
            })),
            null,
            2
          ),
          contentType: 'application/json'
        })
        await info.attach('subagent-events', {
          body: JSON.stringify(
            scenario.ws.events.filter(e => e.type.startsWith('subagent.')),
            null,
            2
          ),
          contentType: 'application/json'
        })
        await info.attach('main-page', { body: await scenario.page.screenshot(), contentType: 'image/png' })
        await info.attach('dom', { body: await scenario.page.locator('body').innerText(), contentType: 'text/plain' })
      } finally {
        await scenario.dispose()
      }
    }
  }
})
export { expect }
