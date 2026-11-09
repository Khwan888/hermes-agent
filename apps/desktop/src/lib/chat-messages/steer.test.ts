import { expect, it } from 'vitest'

import { chatMessageText, toChatMessages } from '@/lib/chat-messages'

const marker =
  '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\ncheck errors\n[/OUT-OF-BAND USER MESSAGE]'

it('hydrates a backend-typed steer as the user\'s own words, never the model-facing marker', () => {
  const messages = toChatMessages([{ role: 'user', timestamp: 1, display_kind: 'steer', content: marker }])

  expect(messages).toHaveLength(1)
  // Still a user row: resume reconciles mid-turn corrections against user rows by occurrence.
  expect(messages[0].role).toBe('user')
  expect(chatMessageText(messages[0])).toBe('check errors')
})

it('leaves an ordinary prompt that quotes the marker untouched', () => {
  const ordinary = toChatMessages([{ role: 'user', timestamp: 1, content: marker }])

  expect(ordinary[0].role).toBe('user')
  expect(chatMessageText(ordinary[0])).toContain('OUT-OF-BAND USER MESSAGE')
})
