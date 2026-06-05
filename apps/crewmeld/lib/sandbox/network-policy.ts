/**
 * Kubernetes NetworkPolicy helpers for sandbox Job egress allowlisting.
 *
 * When sandbox_egress_mode = 'allowlist', the Job runner asks this module to
 * build and apply a NetworkPolicy that pins egress to:
 *   - kube-dns (53/UDP, 53/TCP) — so user code can resolve domain names
 *   - configured allowedIps (CIDRs)
 *   - configured allowedDomains (DNS-resolved at build time → CIDR)
 *   - MINIO_ENDPOINT (resolved at build time) — required for tool file IO
 *
 * Caveats: DNS-resolved IPs are a snapshot. CDNs / load-balanced domains with
 * rotating IPs may fail mid-Job. Settings UI should warn users about this.
 */

import { promises as dns } from 'dns'
import http from 'http'
import https from 'https'
import net from 'net'
import { createLogger } from '@crewmeld/logger'

/**
 * Fallback resolvers tried in order when the system resolver
 * (`/etc/resolv.conf`) refuses or returns nothing. Defaults favour
 * China-mainland public resolvers since this product ships there; an
 * international resolver tails the list for offshore deployments. Override
 * via `SANDBOX_FALLBACK_DNS_SERVERS=ip1,ip2,...` to add private resolvers.
 *
 * Why this is needed: `crewmeld` Pods routinely run in environments where
 * the in-cluster DNS (or the host's resolv.conf) refuses egress to the
 * crewmeld API server's network namespace, e.g. when the API server lives on
 * a control-plane node behind a firewall. Without a fallback, the bootstrap
 * mirrors (pypi.tuna, registry.npmmirror) silently drop off the allowlist
 * and every dep install in allowlist mode dies.
 */
const FALLBACK_DNS_SERVERS = (
  process.env.SANDBOX_FALLBACK_DNS_SERVERS ??
  '223.5.5.5,119.29.29.29,114.114.114.114,1.1.1.1'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const DNS_TIMEOUT_MS = 3000

const logger = createLogger('SandboxNetworkPolicy')

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ''
const K8S_API_TOKEN = process.env.K8S_API_TOKEN ?? ''
const K8S_NAMESPACE = process.env.K8S_DEPLOY_NAMESPACE ?? 'crewmeld-skills'
const K8S_SKIP_TLS = process.env.K8S_SKIP_TLS_VERIFY === 'true'

// ---------------------------------------------------------------------------
// K8s API helper (same shape as job-runner.k8sApi but copied locally to avoid
// circular import). Kept tiny on purpose.
// ---------------------------------------------------------------------------

interface K8sResponse {
  ok: boolean
  status: number
  json: () => Promise<Record<string, unknown>>
  text: () => Promise<string>
}

function k8sApi(
  urlPath: string,
  opts: { method: string; body?: unknown }
): Promise<K8sResponse> {
  const url = new URL(urlPath, K8S_API_SERVER)
  const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${K8S_API_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        ...(K8S_SKIP_TLS && isHttps ? { rejectUnauthorized: false } : {}),
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          const status = res.statusCode ?? 500
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(JSON.parse(raw)),
            text: () => Promise.resolve(raw),
          })
        })
      }
    )
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Build allowlist CIDRs
// ---------------------------------------------------------------------------

interface BuildAllowlistOpts {
  allowedIps: string[]
  allowedDomains: string[]
}

interface AllowlistResult {
  cidrs: string[]
  /** Names that failed to resolve — surfaced in logs / error messages. */
  unresolved: string[]
}

/**
 * Hosts the bootstrap shell script hits unconditionally on every Job that
 * installs dependencies (preset or per-job). MUST stay in sync with the
 * mirrors hardcoded in job-runner.ts buildBootstrap(). Without auto-allowing
 * these, every tool with a non-stdlib import fails at install time in
 * allowlist mode.
 */
export const BOOTSTRAP_AUTO_ALLOWED_DOMAINS = [
  'pypi.tuna.tsinghua.edu.cn',
  'registry.npmmirror.com',
] as const

/**
 * Turn the user-configured IPs + domains (plus auto-allowed bootstrap mirrors
 * and MINIO_ENDPOINT) into a deduped list of CIDR strings. Each plain IP
 * becomes `<ip>/32`.
 */
export async function buildAllowlistCidrs(opts: BuildAllowlistOpts): Promise<AllowlistResult> {
  const cidrs = new Set<string>()
  const unresolved: string[] = []

  for (const ip of opts.allowedIps) {
    cidrs.add(ip.includes('/') ? ip : `${ip}/32`)
  }

  const domains = [...opts.allowedDomains]
  // Auto-allow bootstrap package mirrors — without these, every dep install
  // fails in allowlist mode and the Job exits before user code runs.
  for (const host of BOOTSTRAP_AUTO_ALLOWED_DOMAINS) {
    domains.push(host)
  }
  // Auto-allow MINIO_ENDPOINT host so file uploads keep working in allowlist mode.
  const minioHost = extractHostFromEndpoint(process.env.MINIO_ENDPOINT)
  if (minioHost) domains.push(minioHost)

  for (const domain of domains) {
    if (net.isIP(domain)) {
      // Already an IP — accept directly.
      cidrs.add(`${domain}/32`)
      continue
    }
    try {
      const addrs = await resolveDomainWithFallback(domain)
      for (const a of addrs) cidrs.add(`${a}/32`)
    } catch (err) {
      logger.warn(
        `DNS resolve failed for ${domain} (all resolvers tried): ${err instanceof Error ? err.message : String(err)}`
      )
      unresolved.push(domain)
    }
  }

  return { cidrs: Array.from(cidrs).sort(), unresolved }
}

/**
 * Resolve a hostname to IPv4 addresses, falling back to public DNS servers
 * when the OS resolver fails. Each attempt is capped at {@link DNS_TIMEOUT_MS}
 * so a slow upstream cannot stall Job creation indefinitely.
 *
 * Returns the first successful resolver's answers; throws when every resolver
 * in the chain fails. The first fallback success is logged so operators can
 * see that their local DNS is misconfigured even when the workflow continues.
 */
async function resolveDomainWithFallback(domain: string): Promise<string[]> {
  // System resolver first — when it works it's the freshest answer (uses
  // whatever the operator has configured, including internal DNS zones).
  try {
    return await raceTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS)
  } catch (sysErr) {
    const sysMsg = sysErr instanceof Error ? sysErr.message : String(sysErr)

    for (const server of FALLBACK_DNS_SERVERS) {
      const resolver = new dns.Resolver()
      resolver.setServers([server])
      try {
        const addrs = await raceTimeout(resolver.resolve4(domain), DNS_TIMEOUT_MS)
        logger.info(
          `DNS fallback succeeded: ${domain} resolved via ${server} (${addrs.join(',')}) — system resolver failed: ${sysMsg}`
        )
        return addrs
      } catch {
        // Try the next server; final failure surfaces from the throw below.
      }
    }

    throw new Error(
      `system + ${FALLBACK_DNS_SERVERS.length} fallback resolvers all failed (last sys error: ${sysMsg})`
    )
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DNS timeout after ${ms}ms`)), ms)
    }),
  ])
}

function extractHostFromEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint) return null
  try {
    const withScheme = endpoint.includes('://') ? endpoint : `http://${endpoint}`
    return new URL(withScheme).hostname || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// NetworkPolicy spec
// ---------------------------------------------------------------------------

export interface BuildPolicyOpts {
  /** The Job name — used as the policy name and as the podSelector label match. */
  jobName: string
  cidrs: string[]
  /**
   * Resolved DNS Service ClusterIP. Provided as an ipBlock fallback for CNIs
   * that evaluate NetworkPolicy before kube-proxy DNAT (e.g. older Calico
   * configs), where the podSelector-based DNS rule alone would deny lookups
   * routed via the Service IP. Null if resolution failed — DNS still works on
   * post-DNAT CNIs via the podSelector rules below.
   */
  kubeDnsClusterIp: string | null
}

/**
 * Build a NetworkPolicy that pins egress for Pods labeled job-name=<jobName>.
 *
 * Allowed:
 *   - DNS to kube-system / kube-dns or coredns Pods (UDP+TCP 53)
 *   - DNS to the kube-dns Service ClusterIP when known (pre-DNAT CNIs)
 *   - Every CIDR in `cidrs`
 *
 * Everything else (incl. internet, other namespaces) is denied via the
 * implicit "default deny" introduced by having a NetworkPolicy with Egress
 * in policyTypes but no rule matching the destination.
 */
export function buildSandboxNetworkPolicy(opts: BuildPolicyOpts): Record<string, unknown> {
  const peers: Array<Record<string, unknown>> = []

  // DNS — multiple `to` peers are OR'd within one rule, so we cover both the
  // kubeadm/k3s convention (k8s-app=kube-dns) and the upstream CoreDNS Helm
  // chart convention (app.kubernetes.io/name=coredns).
  const dnsPeers: Array<Record<string, unknown>> = [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
      podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
    },
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'coredns' } },
    },
  ]
  if (opts.kubeDnsClusterIp) {
    dnsPeers.push({ ipBlock: { cidr: `${opts.kubeDnsClusterIp}/32` } })
  }
  peers.push({
    to: dnsPeers,
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  })

  // Allowlisted external CIDRs.
  if (opts.cidrs.length > 0) {
    peers.push({
      to: opts.cidrs.map((cidr) => ({ ipBlock: { cidr } })),
    })
  }

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: networkPolicyName(opts.jobName),
      namespace: K8S_NAMESPACE,
      labels: {
        app: 'crewmeld-tool-job',
        'managed-by': 'crewmeld-sandbox',
        'job-name': opts.jobName,
      },
    },
    spec: {
      podSelector: { matchLabels: { 'job-name': opts.jobName } },
      policyTypes: ['Egress'],
      egress: peers,
    },
  }
}

export function networkPolicyName(jobName: string): string {
  return `${jobName}-egress`
}

// ---------------------------------------------------------------------------
// kube-dns ClusterIP resolution
// ---------------------------------------------------------------------------

/**
 * Candidate Service names to probe in kube-system for the cluster DNS IP.
 * `kube-dns` is the conventional name even when the implementation is CoreDNS
 * (kubeadm / k3s / EKS / GKE). The alternatives cover Helm-chart deployments
 * and RKE2.
 */
const KUBE_DNS_SERVICE_CANDIDATES = ['kube-dns', 'coredns', 'rke2-coredns-rke2-coredns'] as const

let cachedKubeDnsClusterIp: string | null = null

/**
 * Resolve the cluster DNS Service ClusterIP via the K8s API. Successful
 * lookups are cached for the process lifetime — the ClusterIP doesn't change
 * without operator intervention. Failures are NOT cached so a transient API
 * blip during startup doesn't permanently disable the ipBlock fallback.
 */
export async function getKubeDnsClusterIp(): Promise<string | null> {
  if (cachedKubeDnsClusterIp) return cachedKubeDnsClusterIp

  for (const name of KUBE_DNS_SERVICE_CANDIDATES) {
    const res = await k8sApi(`/api/v1/namespaces/kube-system/services/${name}`, {
      method: 'GET',
    }).catch(() => null)
    if (!res || !res.ok) continue
    const body = (await res.json()) as { spec?: { clusterIP?: string } }
    const ip = body.spec?.clusterIP
    if (ip && net.isIP(ip)) {
      cachedKubeDnsClusterIp = ip
      return ip
    }
  }
  logger.warn(
    `kube-dns ClusterIP not found via ${KUBE_DNS_SERVICE_CANDIDATES.join('/')} — falling back to podSelector-only DNS rules`
  )
  return null
}

// ---------------------------------------------------------------------------
// Apply / delete
// ---------------------------------------------------------------------------

export async function applyNetworkPolicy(spec: Record<string, unknown>): Promise<void> {
  const res = await k8sApi(`/apis/networking.k8s.io/v1/namespaces/${K8S_NAMESPACE}/networkpolicies`, {
    method: 'POST',
    body: spec,
  })
  if (!res.ok) {
    const body = await res.text()
    // 409 AlreadyExists is fine (e.g. retry); everything else surfaces as error.
    if (res.status !== 409) {
      throw new Error(`Failed to create NetworkPolicy: ${body.slice(0, 300)}`)
    }
  }
}

export async function deleteNetworkPolicy(jobName: string): Promise<void> {
  await k8sApi(
    `/apis/networking.k8s.io/v1/namespaces/${K8S_NAMESPACE}/networkpolicies/${networkPolicyName(jobName)}`,
    { method: 'DELETE' }
  )
}

// ---------------------------------------------------------------------------
// Orphan reconciler — sweeps NPs whose Job is gone.
// ---------------------------------------------------------------------------

interface NetworkPolicyItem {
  metadata: { name: string; labels?: Record<string, string> }
}

interface JobItem {
  metadata: { name: string }
}

/**
 * List existing job-*-egress NetworkPolicies and delete any whose owning Job
 * no longer exists. Safe to call repeatedly; intended for one-shot use at
 * process startup.
 */
export async function reconcileOrphanNetworkPolicies(): Promise<{
  scanned: number
  deleted: number
}> {
  const npRes = await k8sApi(
    `/apis/networking.k8s.io/v1/namespaces/${K8S_NAMESPACE}/networkpolicies?labelSelector=managed-by=crewmeld-sandbox`,
    { method: 'GET' }
  )
  if (!npRes.ok) {
    logger.warn(`Orphan NP reconciler: list NPs failed (${npRes.status})`)
    return { scanned: 0, deleted: 0 }
  }
  const npBody = (await npRes.json()) as { items?: NetworkPolicyItem[] }
  const nps = npBody.items ?? []
  if (nps.length === 0) return { scanned: 0, deleted: 0 }

  const jobRes = await k8sApi(
    `/apis/batch/v1/namespaces/${K8S_NAMESPACE}/jobs?labelSelector=app=crewmeld-tool-job`,
    { method: 'GET' }
  )
  const aliveJobs = new Set<string>()
  if (jobRes.ok) {
    const jobBody = (await jobRes.json()) as { items?: JobItem[] }
    for (const j of jobBody.items ?? []) aliveJobs.add(j.metadata.name)
  }

  let deleted = 0
  for (const np of nps) {
    const owningJob = np.metadata.labels?.['job-name']
    if (!owningJob) continue
    if (aliveJobs.has(owningJob)) continue
    try {
      await k8sApi(
        `/apis/networking.k8s.io/v1/namespaces/${K8S_NAMESPACE}/networkpolicies/${np.metadata.name}`,
        { method: 'DELETE' }
      )
      deleted++
      logger.info(`Orphan NP deleted: ${np.metadata.name}`)
    } catch (err) {
      logger.warn(
        `Failed to delete orphan NP ${np.metadata.name}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return { scanned: nps.length, deleted }
}
