/**
 * Flattened role record used by the employee onboarding wizard.
 * Roles are now a first-class concept — not embedded inside templates.
 */
export interface FlatRole {
  /** Stable row ID in the `roles` table */
  id: string
  /** Human-readable role name */
  name: string
  /** Role description. May be null when the role was created without one. */
  description: string | null
  persona?: string
  /** Default block type for employees created from this role */
  blockType: string
  category: string
  icon?: string | null
}

/** API response shape for GET /api/employee/roles */
export interface RoleListResponse {
  success: boolean
  data: FlatRole[]
}

/** Request body for POST /api/employee/roles */
export interface CreateRoleRequest {
  name: string
  description?: string
  persona?: string
  blockType?: string
  category?: string
  icon?: string
}

/** API response shape for POST /api/employee/roles */
export interface CreateRoleResponse {
  success: boolean
  data: FlatRole
}
