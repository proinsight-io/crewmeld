/**
 * Client-safe helpers for surfacing a selected system connection to the
 * dev-studio model.
 *
 * The studio never sends raw credentials to the model — only the *names* of
 * the `CONN_*` environment variables the tool can read. Those names are a pure
 * string transform of the connection's config keys, so they can be derived on
 * the client from the masked `configPreview` returned by
 * `GET /api/employee/connectors?withConfig=true` (no decryption, no secrets).
 *
 * This mirrors the server-side derivation in
 * `@/lib/connectors/resolve-conn-env`, which is what actually injects the
 * real values into the test-run sandbox.
 */

/** Metadata about a chosen connection, forwarded by the connection pickers. */
export interface ConnectionSelectionInfo {
  /** Human-friendly connection name (shown to the operator + the model). */
  name: string
  /** Connection type, e.g. `database`, `custom_api`. */
  type: string
  /** Masked config preview — keys are real, values are masked/safe. */
  configPreview: Record<string, unknown>
}

/**
 * Shared selection callback for both the header {@link ConnectionSelector} and
 * the test-panel `ConnectionPicker`. `info` is `null` when the selection is
 * cleared (the "no connection" entry).
 */
export type OnConnectionChange = (id: string | null, info: ConnectionSelectionInfo | null) => void

/**
 * Convert a camelCase config key to its `CONN_*` environment variable name.
 * e.g. `host` -> `CONN_HOST`, `apiKey` -> `CONN_API_KEY`.
 *
 * Kept byte-for-byte in sync with `configKeyToEnvName` in
 * `@/lib/connectors/resolve-conn-env` so the names shown to the model match
 * what the sandbox actually injects at run time.
 */
export function configKeyToEnvName(key: string): string {
  return `CONN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/**
 * Derive the list of `CONN_*` environment variable names a tool can read for
 * the given connection, from its masked config preview. Empty/blank fields are
 * skipped (they are not injected), and the synthetic `CONN_TYPE` is always
 * appended — matching the server-side resolver.
 */
export function buildConnEnvKeys(configPreview: Record<string, unknown>): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(configPreview)) {
    if (value != null && value !== '') {
      keys.push(configKeyToEnvName(key))
    }
  }
  keys.push('CONN_TYPE')
  return keys
}
