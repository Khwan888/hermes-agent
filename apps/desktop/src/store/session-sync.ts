// Cross-window session-list sync. Each desktop window is its own renderer
// process with its own gateway socket and session store, so a mutation in one
// (e.g. a new chat started in the compact pop-out) never reaches another
// window. This bus pings every window to re-pull the shared session list; the
// data already lives in the backend, the other window just doesn't know to look.
const CHANNEL = 'hermes:sessions'

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)

// A window that mutated the session list (created / titled a chat) tells the
// others to refresh. A BroadcastChannel never delivers to its own poster, so the
// caller refreshes locally as it already does.
export function broadcastSessionsChanged(): void {
  channel?.postMessage(1)
}

const localHandlers = new Set<() => void>()

/** A store-level write (no hook in reach) that changed list projections the
 *  backend computes — e.g. a subagent marked read lowers its ancestors'
 *  roll-ups. Re-pull here (a newer list request voids any page already in
 *  flight, which may predate the write) and in every other window. */
export function sessionsChangedHere(): void {
  localHandlers.forEach(handler => handler())
  broadcastSessionsChanged()
}

export function onSessionsChanged(handler: () => void): () => void {
  localHandlers.add(handler)
  channel?.addEventListener('message', handler)

  return () => {
    localHandlers.delete(handler)
    channel?.removeEventListener('message', handler)
  }
}
