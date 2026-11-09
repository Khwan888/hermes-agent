/** Backend projection shared by parent conversations and their delegate children. */
export interface SessionSubagentInfo {
  /** True for an internal delegate_task child. Exact-id endpoints return these
   *  rows for direct watch/resume, but ordinary session lists must not surface
   *  them. Undefined against backends predating the projection. */
  is_internal_child?: boolean
  /** Direct delegate children across this conversation's compression lineage. */
  subagent_count?: number
  /** Durable delegate parent, when projected by the backend. */
  _delegate_from?: null | string
}
