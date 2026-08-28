import type { HumanHandoffStatus } from '@crewmeld/db/schema'

interface HandoffOwnership {
  status: HumanHandoffStatus
  assigneeId: string | null
  claimedByUserId: string | null
}

type HandoffAction =
  | { action: 'claim' }
  | { action: 'assign'; assigneeId: string }
  | { action: 'close' }

/** Derive persisted ownership without mixing collaborator and platform-user identifiers. */
export function resolveHandoffAction(
  current: HandoffOwnership,
  action: HandoffAction,
  platformUserId: string
): HandoffOwnership {
  if (action.action === 'claim') {
    return { ...current, status: 'assigned', claimedByUserId: platformUserId }
  }
  if (action.action === 'assign') {
    return {
      status: 'assigned',
      assigneeId: action.assigneeId,
      claimedByUserId: null,
    }
  }
  return { ...current, status: 'resolved' }
}

/** Enforce exclusive ownership only when a platform user has claimed the handoff. */
export function canReplyToHandoff(
  handoff: Pick<HandoffOwnership, 'claimedByUserId'>,
  platformUserId: string
): boolean {
  return !handoff.claimedByUserId || handoff.claimedByUserId === platformUserId
}
