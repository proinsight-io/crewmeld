/**
 * Network egress rule construction for the test sandbox.
 *
 * Final egress allow-list = systemAllow ∪ manifest.dependencies.domains ∪
 * userAdHocList. Each source carries different validation:
 *   - systemAllow (env var, admin-controlled): no validation, trust admin
 *   - manifestDomains: enforce FQDN format (no IP, no URL, no port)
 *   - userAdHocList (per-run textarea): accept any non-empty string; users
 *     may legitimately need to whitelist an internal database IP
 */

import type { EgressMode } from '@/lib/sandbox/settings'
import type { NetworkPolicy, NetworkPolicyRule } from './opensandbox-client'

/**
 * Hostname labels: 1-63 chars of `[a-z0-9-]`, not starting/ending with `-`.
 * Final TLD must contain at least one letter — this is what rejects bare
 * IPv4 (e.g. `10.0.0.5`) while still accepting normal FQDNs.
 */
const FQDN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i

/** Read CREWMELD_SANDBOX_SYSTEM_EGRESS, comma-split, trim, drop empties. */
export function buildSystemAllow(): string[] {
  const raw = process.env.CREWMELD_SANDBOX_SYSTEM_EGRESS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build the final egress rule list (action=allow only).
 *
 * @param manifestDomains - Caller is expected to have validated these via
 *   {@link validateManifestDomains}; passed in pre-validated.
 * @param userAdHoc - Raw user-supplied list from the test panel textarea.
 *   No validation here; user is trusted within their own workspace.
 */
export function buildEgress(
  manifestDomains: string[],
  userAdHoc: string[]
): NetworkPolicyRule[] {
  const set = new Set<string>()
  for (const d of [...buildSystemAllow(), ...manifestDomains, ...userAdHoc]) {
    const t = d.trim()
    if (t.length > 0) set.add(t)
  }
  return [...set].map((target) => ({ action: 'allow' as const, target }))
}

/** Extra allow-sources folded into a tool's egress in allowlist mode. */
export interface ToolNetworkPolicyOpts {
  /** Always-allow domains regardless of mode source (e.g. pypi mirrors at deploy). */
  extraDomains?: string[]
  /** Admin global allowlist domains from sandbox settings. */
  globalDomains?: string[]
  /** Admin global allowlist IPs/CIDRs from sandbox settings. */
  globalIps?: string[]
  /** Per-tool manifest-declared IPs (FQDN-only validation does not apply to IPs). */
  toolIps?: string[]
}

/**
 * Build the egress {@link NetworkPolicy} for a deployed/invoked tool sandbox,
 * governed by the admin global egress mode (Sub-spec C, Model A):
 *
 *  - `unrestricted` → `{ defaultAction: 'allow' }`: the tool may reach any
 *    external host. (This is the out-of-box default — see sandbox settings.)
 *  - `allowlist` → `{ defaultAction: 'deny', egress }` where egress unions the
 *    tool's manifest domains with the admin global allow-lists, per-tool IPs,
 *    any caller extras, and `CREWMELD_SANDBOX_SYSTEM_EGRESS` (via
 *    {@link buildEgress}), deduplicated.
 *
 * Used by all three tool runtimes — deploy (service), invoke (script), and the
 * dev-studio test sandbox — so the admin egress mode governs them uniformly.
 * The test sandbox passes its per-run 临时白名单 (extraEgress) as an extra
 * allow source, which only takes effect in allowlist mode.
 */
export function buildToolNetworkPolicy(
  egressMode: EgressMode,
  manifestDomains: string[],
  opts: ToolNetworkPolicyOpts = {}
): NetworkPolicy {
  if (egressMode !== 'allowlist') {
    return { defaultAction: 'allow' }
  }
  const adHoc = [
    ...(opts.extraDomains ?? []),
    ...(opts.globalDomains ?? []),
    ...(opts.globalIps ?? []),
    ...(opts.toolIps ?? []),
  ]
  return { defaultAction: 'deny', egress: buildEgress(manifestDomains, adHoc) }
}

/**
 * Throw if any manifest-declared domain fails FQDN format. IP addresses,
 * URLs, ports, and protocols are all rejected — manifest is the authored
 * source where the tool's external dependencies live, and authors must use
 * canonical FQDNs.
 */
export function validateManifestDomains(domains: string[]): void {
  for (const d of domains) {
    if (!FQDN_RE.test(d)) {
      throw new Error(
        `manifest.dependencies.domains entry '${d}' is not a valid FQDN`
      )
    }
  }
}
