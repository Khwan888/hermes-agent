import type { SubagentRoute } from '@hermes/shared'

/** The child's last persisted runtime observation (what actually ran, how it ended). Sanitized by
 *  the child-listing route; null when none was stored or it is unreadable. */
export interface StoredSubagentObservation {
  status: null | string
  route: null | Partial<SubagentRoute>
  duration_seconds: null | number
}

/** Backend projection shared by parent conversations and their delegate children. */
export interface SessionSubagentInfo {
  /** True for an internal delegate_task child. Exact-id endpoints return these
   *  rows for direct watch/resume, but ordinary session lists must not surface
   *  them. Undefined against backends predating the projection. */
  is_internal_child?: boolean
  end_reason?: null | string
  /** Direct delegate children across this conversation's compression lineage. */
  subagent_count?: number
  /** Durable delegate parent, when projected by the backend. */
  _delegate_from?: null | string
  /** Only on `/api/sessions/{id}/subagents` rows from backends that persist observations. */
  subagent_observation?: null | StoredSubagentObservation
}
