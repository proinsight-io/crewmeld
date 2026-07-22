/**
 * Notification-method matching for human_employee approval nodes.
 *
 * The SOP editor stores selected notification methods in `notifyMethod: string[]`.
 * Each entry is one of:
 * - a specific contact, encoded as `"type:value"` (e.g. `"feishu:ou_abc123"`), or
 * - a bare contact type (e.g. `"feishu"`), the legacy form meaning "all contact
 *   methods of that type". Existing SOPs keep this semantics untouched until the
 *   node is re-saved.
 */

/**
 * A structured contact method. Compatible with both the editor panel's
 * `ContactMethod` (`{ type: string }`) and the db `ContactMethod`
 * (`{ type: ContactMethodType }`), so it can be shared across both layers.
 */
export interface NotifyContact {
  type: string
  value: string
}

/**
 * Encode a contact method as its stable notify-method key: `"type:value"`.
 */
export function contactKey(contact: NotifyContact): string {
  return `${contact.type}:${contact.value}`
}

/**
 * Whether a stored notify-method entry selects the given contact.
 *
 * - `"type:value"` (contains a colon): exact match on both type and value.
 *   Splits on the first colon only, since a value may itself contain colons
 *   (e.g. an email address).
 * - `"type"` (no colon): legacy match on type alone — selects every contact of
 *   that type.
 *
 * @param method - A single `notifyMethod` entry.
 * @param contact - A candidate contact method to test.
 */
export function matchesNotifyMethod(method: string, contact: NotifyContact): boolean {
  const colon = method.indexOf(':')
  if (colon === -1) {
    return method === contact.type
  }
  const type = method.slice(0, colon)
  const value = method.slice(colon + 1)
  return type === contact.type && value === contact.value
}

/**
 * Extract the platform/channel type from a notify-method entry. For a
 * `"type:value"` key this is the part before the first colon; for a legacy bare
 * type it's the whole string. Use it to count distinct platforms — several
 * contacts of the same type collapse to one platform.
 */
export function notifyMethodType(method: string): string {
  const colon = method.indexOf(':')
  return colon === -1 ? method : method.slice(0, colon)
}
