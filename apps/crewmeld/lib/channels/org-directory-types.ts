/**
 * Cross-channel org-structure list types — used by the SOP permission UI's
 * department / user pickers. Separate from per-user ChannelUserDetail: these
 * model "browse the org tree" rather than "look up one known user".
 */

/** One department node in a channel org tree. */
export interface DepartmentNode {
  /** Channel-native department id (string form). */
  id: string
  name: string
  /** Parent department id; absent/"0" for tenant root children. */
  parentId?: string
  /** Whether the node has child departments (drives lazy expansion). */
  hasChildren?: boolean
}

/** One user when listing a department's members. */
export interface DirectoryUser {
  /** Channel-native user id (same id space as ScopeIdentity.employeeId). */
  userId: string
  name: string
}

/** Paginated user-list page. */
export interface DirectoryUserPage {
  users: DirectoryUser[]
  /** Opaque cursor for the next page; absent when no more pages. */
  nextCursor?: string
}
