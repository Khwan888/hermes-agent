import { describe, expect, it } from 'vitest'

import { sameSessionOwner } from './session-owner-equality'

// A saved tile may omit whitespace/default profile details, but must never
// equate two different connections or backend-profile overrides.
describe('session owner equality', () => {
  it('normalizes profile-only owners without treating unknown owners as equal', () => {
    expect(sameSessionOwner(' work ', 'work')).toBe(true)
    expect(sameSessionOwner('', 'default')).toBe(true)
    expect(sameSessionOwner('work', 'default')).toBe(false)
    expect(sameSessionOwner(undefined, undefined)).toBe(false)
    expect(sameSessionOwner(null, null)).toBe(false)
  })

  it('compares both connection and effective backend profile for exact routes', () => {
    const owner = { connectionId: ' remote ', profile: ' work ' }

    expect(sameSessionOwner(owner, { connectionId: 'remote', profile: 'work', targetProfile: 'work' })).toBe(true)
    expect(sameSessionOwner(owner, { connectionId: 'other', profile: 'work' })).toBe(false)
    expect(sameSessionOwner(owner, { connectionId: 'remote', profile: 'other' })).toBe(false)
    expect(sameSessionOwner(owner, { connectionId: 'remote', profile: 'work', targetProfile: 'other' })).toBe(false)
    expect(sameSessionOwner(owner, 'work')).toBe(false)
  })
})
