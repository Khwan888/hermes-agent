import { useEffect, useRef } from 'react'

import { SESSION_SEARCH_FOCUS_EVENT } from '@/store/layout'

/** Hotkey focus waits for the sidebar's search field to be mounted. */
export function useSidebarSearchFocus() {
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onFocus = () => searchInputRef.current?.focus({ preventScroll: true })

    window.addEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)

    return () => window.removeEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)
  }, [])

  return searchInputRef
}
