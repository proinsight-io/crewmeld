/**
 * Static egress scanner for the tool dev-studio dependency review flow.
 *
 * Extracts the external hosts a tool's source code reaches — HTTP(S) URL
 * domains and bare IPv4/CIDR literals — so the review card can prompt the
 * operator to confirm them into the tool manifest's egress allow-list.
 *
 * Deliberately conservative: it matches only literal URLs and literal IPs.
 * Dynamically assembled URLs (`base + path`) are not detected — the AI-authored
 * `manifest.dependencies` remains the authoritative source that backstops this
 * (see the dev-studio persona protocol). False positives are acceptable because
 * the operator prunes them in the review card before anything is written.
 */

/** Placeholder / loopback hosts that must never be surfaced for confirmation. */
const IGNORED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'example.com'])

/** IPv4 (optionally CIDR). Octet range is validated separately. */
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

/** RFC 1123 hostname (segments alphanumeric + hyphen, dots between). */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

/** `scheme://[user:pw@]host[:port]...` — captures the raw host token. */
const URL_HOST_RE = /https?:\/\/(?:[^/@\s"']*@)?([^/:\s"'?#]+)/gi

/** Standalone IPv4/CIDR token not necessarily inside a URL. */
const BARE_IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\b/g

/** True when every octet is 0-255 and the CIDR prefix (if any) is 0-32. */
function isValidIpv4Cidr(token: string): boolean {
  const m = IPV4_CIDR_RE.exec(token)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  if (octets.some((n) => n < 0 || n > 255)) return false
  if (m[5]) {
    const prefix = Number(m[5].slice(1))
    if (prefix < 0 || prefix > 32) return false
  }
  return true
}

/**
 * Scan source texts for external egress targets.
 *
 * @param sources - Raw text of each candidate source file.
 * @returns Deduplicated `domains` (lowercased, FQDN-valid) and `ips`
 *   (IPv4/CIDR, octet-validated). Loopback/placeholder hosts are dropped;
 *   malformed tokens are silently discarded.
 */
export function scanEgress(sources: string[]): { domains: string[]; ips: string[] } {
  const domains = new Set<string>()
  const ips = new Set<string>()

  for (const text of sources) {
    // URL hosts.
    for (const match of text.matchAll(URL_HOST_RE)) {
      const host = match[1]?.trim()
      if (!host) continue
      classify(host, domains, ips)
    }
    // Bare IP/CIDR literals.
    for (const match of text.matchAll(BARE_IP_RE)) {
      classify(match[1], domains, ips)
    }
  }

  return { domains: [...domains], ips: [...ips] }
}

/** Route one host token into the domain or IP set, applying all filters. */
function classify(rawHost: string, domains: Set<string>, ips: Set<string>): void {
  const host = rawHost.toLowerCase()
  if (IGNORED_HOSTS.has(host)) return
  if (IPV4_CIDR_RE.test(host)) {
    if (isValidIpv4Cidr(host)) ips.add(host)
    return
  }
  if (HOSTNAME_RE.test(host)) domains.add(host)
}
