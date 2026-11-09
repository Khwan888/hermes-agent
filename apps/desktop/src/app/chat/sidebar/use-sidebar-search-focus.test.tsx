import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { SESSION_SEARCH_FOCUS_EVENT } from '@/store/layout'

import { useSidebarSearchFocus } from './use-sidebar-search-focus'

function SearchField() {
  return <input aria-label="Session search" ref={useSidebarSearchFocus()} />
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('focuses the mounted search field without scrolling when the search hotkey fires', () => {
  render(<SearchField />)
  const field = screen.getByRole('textbox', { name: 'Session search' })
  const focus = vi.spyOn(field, 'focus')

  act(() => window.dispatchEvent(new Event(SESSION_SEARCH_FOCUS_EVENT)))

  expect(field.matches(':focus')).toBe(true)
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
})

it('removes the old listener on unmount and focuses the replacement field', () => {
  const remove = vi.spyOn(window, 'removeEventListener')
  const first = render(<SearchField />)
  first.unmount()
  expect(remove).toHaveBeenCalledWith(SESSION_SEARCH_FOCUS_EVENT, expect.any(Function))

  render(<SearchField />)
  const field = screen.getByRole('textbox', { name: 'Session search' })

  act(() => window.dispatchEvent(new Event(SESSION_SEARCH_FOCUS_EVENT)))

  expect(field.matches(':focus')).toBe(true)
})
