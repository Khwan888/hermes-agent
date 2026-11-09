import { beforeEach, expect, it } from 'vitest'

import { $liveWorkRoster, setLiveWorkRosterSource } from './live-work-roster'

beforeEach(() => $liveWorkRoster.set({}))
it('keeps optional per-conversation attention across roster reads and removes cleared counts', () => {
  setLiveWorkRosterSource('host', [{ session_id: 'root', subagents: 3, attention: { waiting: 1, stuck: 2 } }])
  expect($liveWorkRoster.get().host.sessions.root.attention).toEqual({ waiting: 1, stuck: 2 })
  setLiveWorkRosterSource('host', [{ session_id: 'root', subagents: 2 }])
  expect($liveWorkRoster.get().host.sessions.root.attention).toBeUndefined()
})
it('rejects malformed, negative and nonfinite attention counts', () => {
  setLiveWorkRosterSource('host', [{ session_id: 'root', attention: { waiting: -1, stuck: Infinity } }])
  expect($liveWorkRoster.get().host.sessions.root.attention).toBeUndefined()
})
