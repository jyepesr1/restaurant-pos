import type { AccessControl } from '../hub/hub'

/** Access control that lets everything through: to test sync on its own. */
export const openAccess: AccessControl = {
  verify: () => ({ ok: true, authorizedById: null, authorizationId: null }),
  recordUse: () => {},
}
