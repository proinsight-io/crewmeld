/**
 * Notification types shared by the global NotificationCenter widget and its
 * per-kind cards.
 *
 * The shapes mirror what `GET /api/employee/dev-studio/notifications` returns
 * — see `apps/crewmeld/app/api/employee/dev-studio/notifications/route.ts` —
 * but are re-declared here so the card components do not need to import from
 * a dev-studio internal hook.
 */

/** Dependency approval notification — one per session with unapproved deps. */
export interface DependencyNotification {
  sessionId: string
  sessionTitle: string
  pendingLibraries: string[]
  pendingDomains: string[]
  streaming: boolean
}

/** Pending HITL ask — one row from `tool_dev_pending_actions`. */
export interface AskNotification {
  sessionId: string
  sessionTitle: string
  askId: string
  type: string
  payload: unknown
  streaming: boolean
}

/** Payload shape for `type === 'choice'` asks. */
export interface ChoiceAskPayload {
  question: string
  options: Array<{ value: string; label: string }>
}

/** Payload shape for `type === 'confirm'` asks. */
export interface ConfirmAskPayload {
  question: string
}

/** Payload shape for `type === 'text'` asks. */
export interface TextAskPayload {
  prompt: string
  placeholder?: string
}
