import { afterEach, expect, test } from 'vitest'

import { type ScriptedProvider, startScriptedProvider } from './provider'

let provider: ScriptedProvider

afterEach(async () => {
  await provider?.close()
})

const user = (content: unknown) => ({ role: 'user', content })
const assistant = { role: 'assistant', content: 'checkpoint' }

async function complete(messages: unknown[]) {
  const response = await fetch(`${provider.url}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages, model: 'mock-model' })
  })

  return (await response.json()).choices[0].message.content
}

test('legacy last-user and prompt scripts remain deterministic and preserve JSON tool calls', async () => {
  provider = await startScriptedProvider()
  provider.script('U8-next', [
    { reasoning: ['reason'], toolCalls: [{ name: 'clarify', args: { question: 'Which?' } }] }
  ])
  provider.scriptPrompt('aux', 'summarize this', [{ text: ['summary'] }])

  const response = await fetch(`${provider.url}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [user('U7-old'), assistant, user('U8-next')] })
  })

  const body = await response.json()
  expect(body.choices[0]).toMatchObject({
    finish_reason: 'tool_calls',
    message: {
      reasoning_content: 'reason',
      content: null,
      tool_calls: [{ type: 'function', function: { name: 'clarify', arguments: '{"question":"Which?"}' } }]
    }
  })
  expect(await complete([user('please summarize this')])).toBe('summary')
  expect(await complete([user('unknown')])).toBe('ok')
  expect(provider.completions.map(c => c.marker)).toEqual(['U8-next', 'aux', null])
})

test('first-user routing keeps subagent, steer and quoted parent notice scripts separate on retries', async () => {
  provider = await startScriptedProvider({ routing: 'first-user' })
  provider.script('K11-alpha', [{ text: ['helper'] }, { text: ['checkpoint reply'] }])
  provider.script('K11-alpha~s', [{ text: ['steered'] }])
  provider.script('U1-parent~n', [{ text: ['notice'] }])
  const child = [user([{ type: 'text', text: 'K11-alpha goal' }])]
  expect(await complete(child)).toBe('helper')
  expect(await complete([...child, assistant])).toBe('checkpoint reply')
  expect(await complete([...child, assistant, user('OOB: change direction')])).toBe('steered')
  const notice = [user('U1-parent delegate'), assistant, user('Finished K11-alpha goal')]
  expect(await complete(notice)).toBe('notice')
  expect(await complete(notice)).toBe('notice')
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
