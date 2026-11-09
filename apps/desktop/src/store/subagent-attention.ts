import type { SubagentPayload, SubagentProgress, SubagentStatus } from './subagents'

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const optionalNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const TERMINAL = new Set<SubagentStatus>(['completed', 'failed', 'interrupted'])

export function subagentAttentionFields(
  payload: SubagentPayload,
  prev: SubagentProgress | undefined,
  status: SubagentStatus,
  eventType: string
): Pick<SubagentProgress, 'attention' | 'attentionReason' | 'attentionSince' | 'exitReason' | 'unread'> {
  const terminal = TERMINAL.has(status)
  const transition = Object.hasOwn(payload, 'attention')
  const requested = transition ? payload.attention : prev?.attention
  const resumed = !transition && requested === 'stuck' && !!eventType

  const attention =
    terminal || resumed ? undefined : requested === 'waiting' || requested === 'stuck' ? requested : undefined

  const reason = transition ? optionalString(payload.attention_reason) : prev?.attentionReason
  const since = transition ? optionalNumber(payload.attention_since) : prev?.attentionSince

  return {
    attention,
    attentionReason: attention === 'waiting' ? reason : undefined,
    attentionSince: attention ? since : undefined,
    exitReason: optionalString(payload.exit_reason) ?? (payload.status === 'timeout' ? 'timeout' : prev?.exitReason),
    unread:
      typeof payload.unread === 'boolean'
        ? payload.unread
        : terminal && eventType === 'subagent.complete'
          ? status !== 'interrupted'
          : prev?.unread
  }
}
