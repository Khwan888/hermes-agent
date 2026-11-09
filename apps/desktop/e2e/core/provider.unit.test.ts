import { afterEach, expect, test } from 'vitest'

import { type ScriptedProvider, startScriptedProvider } from './provider'

let provider: ScriptedProvider

afterEach(async () => {
  await provider?.close()
})

const post = (url: string, body: Record<string, unknown>) =>
  fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) })

test('named routes serve their own model and record the effort actually sent', async () => {
  provider = await startScriptedProvider({ routes: { worker: { model: 'subagent-model' } } })
  provider.script('U1-route', [{ text: ['routed'] }])

  const models = await (await fetch(`${provider.routes.worker.url}/v1/models`)).json()
  expect(models.data[0]).toMatchObject({ id: 'subagent-model', owned_by: 'worker' })

  const reply = await (
    await post(provider.routes.worker.url, {
      model: 'whatever',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'U1-route go' }]
    })
  ).json()

  expect(reply.choices[0].message.content).toBe('routed')
  expect(reply.model).toBe('subagent-model')
  await post(provider.url, { extra_body: {}, reasoning: { effort: 'low' }, messages: [{ role: 'user', content: 'x' }] })
  expect(provider.completions.map(c => [c.route, c.model, c.effort, c.httpStatus])).toEqual([
    ['worker', 'subagent-model', 'high', 200],
    [null, 'mock-model', 'low', 200]
  ])
})

test('a failing route keeps failing on retry; unknown routes 404 without recording', async () => {
  provider = await startScriptedProvider({ routes: { broken: { model: 'failed-model', httpStatus: 503 } } })
  provider.script('U2-route', [{ text: ['never'] }])

  for (let i = 0; i < 2; i++) {
    const response = await post(provider.routes.broken.url, { messages: [{ role: 'user', content: 'U2-route' }] })
    expect(response.status).toBe(503)
  }

  expect((await post(`${provider.url}/routes/missing`, { messages: [] })).status).toBe(404)
  expect(provider.completions).toHaveLength(2)
  expect(provider.completions.every(c => c.route === 'broken' && c.httpStatus === 503 && c.effort === null)).toBe(true)
  expect(provider.completions.every(c => c.sentText === '')).toBe(true)
})
