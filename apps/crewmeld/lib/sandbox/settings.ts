/**
 * Sandbox settings reader.
 *
 * Backed by the platform_settings key-value table. The keys cover the Python
 * preset packages, the egress allowlist (IPs + domains), and the egress mode
 * toggle. All settings have sensible empty defaults so the sandbox keeps
 * working out-of-the-box.
 */

import { db } from '@crewmeld/db'
import { platformSettings } from '@crewmeld/db/schema'

export type EgressMode = 'unrestricted' | 'allowlist'

export interface SandboxSettings {
  presetPythonPackages: string[]
  allowedIps: string[]
  allowedDomains: string[]
  egressMode: EgressMode
}

export const SANDBOX_SETTING_KEYS = [
  'sandbox_preset_python_packages',
  'sandbox_allowed_ips',
  'sandbox_allowed_domains',
  'sandbox_egress_mode',
] as const

export type SandboxSettingKey = (typeof SANDBOX_SETTING_KEYS)[number]

/** Maps the snake_case DB key to the camelCase settings field. */
export const SANDBOX_KEY_TO_FIELD: Record<SandboxSettingKey, keyof SandboxSettings> = {
  sandbox_preset_python_packages: 'presetPythonPackages',
  sandbox_allowed_ips: 'allowedIps',
  sandbox_allowed_domains: 'allowedDomains',
  sandbox_egress_mode: 'egressMode',
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v.trim().length > 0) out.push(v.trim())
  }
  return out
}

function asEgressMode(value: unknown): EgressMode {
  return value === 'allowlist' ? 'allowlist' : 'unrestricted'
}

/**
 * Load the full sandbox settings object. Single round-trip to the DB —
 * the row count is bounded so the unfiltered scan is fine. Missing keys
 * collapse to empty arrays / 'unrestricted'.
 */
export async function getSandboxSettings(): Promise<SandboxSettings> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)

  const map = new Map<string, unknown>()
  for (const row of rows) {
    map.set(row.key, row.value)
  }

  return {
    presetPythonPackages: asStringArray(map.get('sandbox_preset_python_packages')),
    allowedIps: asStringArray(map.get('sandbox_allowed_ips')),
    allowedDomains: asStringArray(map.get('sandbox_allowed_domains')),
    egressMode: asEgressMode(map.get('sandbox_egress_mode')),
  }
}

// ---------------------------------------------------------------------------
// Validation (shared between API route input check and any other writers)
// ---------------------------------------------------------------------------

const PY_PKG_RE = /^[A-Za-z0-9][\w.\-]*$/
const IPV4_OR_CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
// RFC 1123 hostname (simplified — segments alphanumeric + hyphen, dots between).
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export interface ValidationResult {
  ok: boolean
  /** Field name → reason. Empty when ok=true. */
  errors: Partial<Record<keyof SandboxSettings, string>>
}

export function validateSandboxSettings(input: Partial<SandboxSettings>): ValidationResult {
  const errors: ValidationResult['errors'] = {}

  if (input.presetPythonPackages) {
    const bad = input.presetPythonPackages.find((p) => !PY_PKG_RE.test(p))
    if (bad) errors.presetPythonPackages = `invalid python package: ${bad}`
  }
  if (input.allowedIps) {
    const bad = input.allowedIps.find((ip) => !IPV4_OR_CIDR_RE.test(ip) || !isValidIpOrCidr(ip))
    if (bad) errors.allowedIps = `invalid IP/CIDR: ${bad}`
  }
  if (input.allowedDomains) {
    const bad = input.allowedDomains.find((d) => !HOSTNAME_RE.test(d))
    if (bad) errors.allowedDomains = `invalid domain: ${bad}`
  }
  if (input.egressMode && input.egressMode !== 'unrestricted' && input.egressMode !== 'allowlist') {
    errors.egressMode = `invalid egress mode: ${String(input.egressMode)}`
  }

  return { ok: Object.keys(errors).length === 0, errors }
}

function isValidIpOrCidr(s: string): boolean {
  const [ip, prefix] = s.split('/')
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  if (prefix !== undefined) {
    const p = Number(prefix)
    if (!Number.isInteger(p) || p < 0 || p > 32) return false
  }
  return true
}
