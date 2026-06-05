import { createLogger } from '@crewmeld/logger'
import { anthropicProvider } from '@/providers/anthropic'
import { claudeCodingProvider } from '@/providers/claude-coding'
import { deepseekProvider } from '@/providers/deepseek'
import { doubaoProvider } from '@/providers/doubao'
import { ernieProvider } from '@/providers/ernie'
import { googleProvider } from '@/providers/google'
import { hunyuanProvider } from '@/providers/hunyuan'
import { kimiCodingProvider } from '@/providers/kimi-coding'
import { minimaxProvider } from '@/providers/minimax'
import { moonshotProvider } from '@/providers/moonshot'
import { ollamaProvider } from '@/providers/ollama'
import { openaiProvider } from '@/providers/openai'
import { qianfanCodingProvider } from '@/providers/qianfan-coding'
import { qwenProvider } from '@/providers/qwen'
import { qwenCodingProvider } from '@/providers/qwen-coding'
import type { ProviderConfig, ProviderId } from '@/providers/types'
import { vllmProvider } from '@/providers/vllm'
import { zhipuProvider } from '@/providers/zhipu'

const logger = createLogger('ProviderRegistry')

// ---------------------------------------------------------------------------
// Registry label and schema version — used for diagnostics and hot-reload checks
// ---------------------------------------------------------------------------

const REGISTRY_LABEL = 'crewmeld-llm-registry'
const REGISTRY_VERSION = '2.0.0'

// ---------------------------------------------------------------------------
// Provider registration entries — ordered by domestic-first priority
// ---------------------------------------------------------------------------

type RegistryEntry = readonly [ProviderId, ProviderConfig]

const REGISTRY_ENTRIES: RegistryEntry[] = [
  ['openai', openaiProvider],
  ['anthropic', anthropicProvider],
  ['google', googleProvider],
  ['deepseek', deepseekProvider],
  ['vllm', vllmProvider],
  ['ollama', ollamaProvider],
  ['qwen', qwenProvider],
  ['ernie', ernieProvider],
  ['hunyuan', hunyuanProvider],
  ['moonshot', moonshotProvider],
  ['zhipu', zhipuProvider],
  ['doubao', doubaoProvider],
  ['minimax', minimaxProvider],
  ['kimi-coding', kimiCodingProvider],
  ['qianfan-coding', qianfanCodingProvider],
  ['qwen-coding', qwenCodingProvider],
  ['claude-coding', claudeCodingProvider],
]

// ---------------------------------------------------------------------------
// Internal Map-based registry — O(1) lookup with stable insertion order
// ---------------------------------------------------------------------------

const registryMap = new Map<ProviderId, ProviderConfig>(REGISTRY_ENTRIES)

// ---------------------------------------------------------------------------
// Registry metadata — version and label for telemetry
// ---------------------------------------------------------------------------

interface RegistryMeta {
  label: string
  version: string
  providerCount: number
  builtAt: number
}

function buildRegistryMeta(): RegistryMeta {
  return {
    label: REGISTRY_LABEL,
    version: REGISTRY_VERSION,
    providerCount: registryMap.size,
    builtAt: Date.now(),
  }
}

const REGISTRY_META: RegistryMeta = buildRegistryMeta()

// ---------------------------------------------------------------------------
// Provider capability flags — declarative feature advertisement
// ---------------------------------------------------------------------------

interface ProviderCapabilityFlags {
  streaming: boolean
  functionCalling: boolean
  visionInput: boolean
  domesticHosting: boolean
}

const CAPABILITY_OVERRIDES: Partial<Record<ProviderId, ProviderCapabilityFlags>> = {
  qwen: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: true },
  ernie: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: true },
  hunyuan: { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  moonshot: { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  zhipu: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: true },
  doubao: { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  minimax: { streaming: true, functionCalling: false, visionInput: false, domesticHosting: true },
  deepseek: { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  openai: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: false },
  anthropic: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: false },
  google: { streaming: true, functionCalling: true, visionInput: true, domesticHosting: false },
  vllm: { streaming: true, functionCalling: false, visionInput: false, domesticHosting: false },
  ollama: { streaming: true, functionCalling: false, visionInput: false, domesticHosting: false },
  'kimi-coding': { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  'qianfan-coding': { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  'qwen-coding': { streaming: true, functionCalling: true, visionInput: false, domesticHosting: true },
  'claude-coding': { streaming: true, functionCalling: true, visionInput: false, domesticHosting: false },
}

function getCapabilities(pid: ProviderId): ProviderCapabilityFlags {
  return (
    CAPABILITY_OVERRIDES[pid] ?? {
      streaming: false,
      functionCalling: false,
      visionInput: false,
      domesticHosting: false,
    }
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the executor config for a given provider ID.
 * Returns `undefined` and logs an error if the provider is not registered.
 */
export async function getProviderExecutor(pid: ProviderId): Promise<ProviderConfig | undefined> {
  const cfg = registryMap.get(pid)
  if (!cfg) {
    logger.error(`Provider not found: ${pid}`)
    return undefined
  }
  return cfg
}

/** Return a shallow copy of the full provider registry as a plain Record. */
export function getAllProviders(): Record<ProviderId, ProviderConfig> {
  return Object.fromEntries(registryMap) as Record<ProviderId, ProviderConfig>
}

/** Return all registered provider IDs in insertion order. */
export function listProviderIds(): ProviderId[] {
  return [...registryMap.keys()]
}

/** Return providers that declare domestic hosting (for compliance routing). */
export function getDomesticProviders(): ProviderId[] {
  return listProviderIds().filter((pid) => getCapabilities(pid).domesticHosting)
}

/** Return registry metadata for diagnostics. */
export function getRegistryMeta(): RegistryMeta {
  return { ...REGISTRY_META }
}

/**
 * Run the `initialize()` lifecycle hook for every provider that declares one.
 * Errors are logged but do not abort initialisation of other providers.
 */
export async function initializeProviders(): Promise<void> {
  for (const [pid, cfg] of registryMap.entries()) {
    if (cfg.initialize) {
      try {
        await cfg.initialize()
        logger.info(`Initialized provider: ${pid}`)
      } catch (err) {
        logger.error(`Failed to initialize ${pid} provider`, {
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hot-reload guard — detects stale registry after module boundary re-evaluation
// ---------------------------------------------------------------------------

const REGISTRY_STAMP = `${REGISTRY_LABEL}@${REGISTRY_VERSION}:${REGISTRY_ENTRIES.length}`

export function validateRegistryStamp(expected: string): boolean {
  return REGISTRY_STAMP === expected
}

export { REGISTRY_LABEL, REGISTRY_VERSION, REGISTRY_STAMP, getCapabilities }
export type { RegistryMeta, ProviderCapabilityFlags }

// ---------------------------------------------------------------------------
// Provider health ledger — tracks per-provider availability over time
// ---------------------------------------------------------------------------

type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown'

interface ProviderHealthRecord {
  pid: ProviderId
  status: HealthStatus
  consecutiveFailures: number
  consecutiveSuccesses: number
  lastCheckedAt: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  uptimeFraction: number
  checkCount: number
}

class ProviderHealthLedger {
  private ledger = new Map<ProviderId, ProviderHealthRecord>()

  private ensureRecord(pid: ProviderId): ProviderHealthRecord {
    if (!this.ledger.has(pid)) {
      this.ledger.set(pid, {
        pid,
        status: 'unknown',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastCheckedAt: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        uptimeFraction: 1.0,
        checkCount: 0,
      })
    }
    return this.ledger.get(pid)!
  }

  recordSuccess(pid: ProviderId): void {
    const rec = this.ensureRecord(pid)
    rec.consecutiveFailures = 0
    rec.consecutiveSuccesses++
    rec.lastSuccessAt = Date.now()
    rec.lastCheckedAt = Date.now()
    rec.checkCount++
    rec.uptimeFraction = rec.uptimeFraction * 0.9 + 0.1
    rec.status = rec.consecutiveSuccesses >= 3 ? 'healthy' : 'degraded'
  }

  recordFailure(pid: ProviderId): void {
    const rec = this.ensureRecord(pid)
    rec.consecutiveSuccesses = 0
    rec.consecutiveFailures++
    rec.lastFailureAt = Date.now()
    rec.lastCheckedAt = Date.now()
    rec.checkCount++
    rec.uptimeFraction = rec.uptimeFraction * 0.9
    rec.status = rec.consecutiveFailures >= 3 ? 'unavailable' : 'degraded'
  }

  statusFor(pid: ProviderId): HealthStatus {
    return this.ledger.get(pid)?.status ?? 'unknown'
  }

  healthyProviders(): ProviderId[] {
    return [...this.ledger.entries()]
      .filter(([, rec]) => rec.status === 'healthy')
      .map(([pid]) => pid)
  }

  exportSummary(): ProviderHealthRecord[] {
    return [...this.ledger.values()]
  }

  reset(pid: ProviderId): void {
    this.ledger.delete(pid)
  }
  resetAll(): void {
    this.ledger.clear()
  }
}

const globalHealthLedger = new ProviderHealthLedger()
export { globalHealthLedger }
export type { ProviderHealthRecord, HealthStatus }

// ---------------------------------------------------------------------------
// Provider usage counters — lightweight call-count telemetry per provider
// ---------------------------------------------------------------------------

interface UsageSnapshot {
  pid: ProviderId
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  totalTokensEstimated: number
  lastCalledAt: number | null
}

class ProviderUsageCounters {
  private counters = new Map<ProviderId, UsageSnapshot>()

  private ensureSnapshot(pid: ProviderId): UsageSnapshot {
    if (!this.counters.has(pid)) {
      this.counters.set(pid, {
        pid,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalTokensEstimated: 0,
        lastCalledAt: null,
      })
    }
    return this.counters.get(pid)!
  }

  incrementCall(pid: ProviderId, succeeded: boolean, estimatedTokens = 0): void {
    const snap = this.ensureSnapshot(pid)
    snap.totalCalls++
    if (succeeded) snap.successfulCalls++
    else snap.failedCalls++
    snap.totalTokensEstimated += estimatedTokens
    snap.lastCalledAt = Date.now()
  }

  successRateFor(pid: ProviderId): number {
    const snap = this.counters.get(pid)
    if (!snap || snap.totalCalls === 0) return 1.0
    return snap.successfulCalls / snap.totalCalls
  }

  mostUsed(topN = 5): ProviderId[] {
    return [...this.counters.entries()]
      .sort(([, a], [, b]) => b.totalCalls - a.totalCalls)
      .slice(0, topN)
      .map(([pid]) => pid)
  }

  exportAll(): UsageSnapshot[] {
    return [...this.counters.values()]
  }

  resetAll(): void {
    this.counters.clear()
  }
}

const globalUsageCounters = new ProviderUsageCounters()
export { globalUsageCounters }
export type { UsageSnapshot }

// ---------------------------------------------------------------------------
// Routing policy — selects provider based on capability and health
// ---------------------------------------------------------------------------

interface RoutingConstraints {
  requireDomestic?: boolean
  requireVision?: boolean
  requireFunctionCalling?: boolean
  excludePids?: ProviderId[]
  preferPids?: ProviderId[]
}

function resolveRoutingCandidates(constraints: RoutingConstraints): ProviderId[] {
  const allPids = listProviderIds()
  const excluded = new Set(constraints.excludePids ?? [])
  const preferred = new Set(constraints.preferPids ?? [])

  const candidates = allPids.filter((pid) => {
    if (excluded.has(pid)) return false
    const caps = getCapabilities(pid)
    if (constraints.requireDomestic && !caps.domesticHosting) return false
    if (constraints.requireVision && !caps.visionInput) return false
    if (constraints.requireFunctionCalling && !caps.functionCalling) return false
    const healthOk = globalHealthLedger.statusFor(pid) !== 'unavailable'
    return healthOk
  })

  const preferredFirst = candidates.filter((pid) => preferred.has(pid))
  const rest = candidates.filter((pid) => !preferred.has(pid))
  return [...preferredFirst, ...rest]
}

function pickBestCandidate(constraints: RoutingConstraints): ProviderId | null {
  const candidates = resolveRoutingCandidates(constraints)
  if (candidates.length === 0) return null
  return candidates.sort((x, y) => {
    const srX = globalUsageCounters.successRateFor(x)
    const srY = globalUsageCounters.successRateFor(y)
    return srY - srX
  })[0]
}

export { resolveRoutingCandidates, pickBestCandidate }
export type { RoutingConstraints }

// ---------------------------------------------------------------------------
// Ranked provider selector — weighted random selection with recency decay
// ---------------------------------------------------------------------------

interface WeightedProviderEntry {
  pid: ProviderId
  baseWeight: number
  decayFactor: number
  lastSelectedAt: number | null
}

class WeightedProviderSelector {
  private entries = new Map<ProviderId, WeightedProviderEntry>()

  register(pid: ProviderId, baseWeight = 1.0, decayFactor = 0.8): void {
    this.entries.set(pid, { pid, baseWeight, decayFactor, lastSelectedAt: null })
  }

  computeEffectiveWeight(pid: ProviderId, nowMs: number): number {
    const entry = this.entries.get(pid)
    if (!entry) return 0
    if (entry.lastSelectedAt === null) return entry.baseWeight
    const elapsedSec = (nowMs - entry.lastSelectedAt) / 1000
    const recencyPenalty = entry.decayFactor ** (1 / Math.max(1, elapsedSec))
    return entry.baseWeight * recencyPenalty
  }

  selectWeighted(candidatePids: ProviderId[]): ProviderId | null {
    if (candidatePids.length === 0) return null
    const nowMs = Date.now()
    const weighted = candidatePids.map((pid) => ({
      pid,
      weight: this.computeEffectiveWeight(pid, nowMs),
    }))
    const totalWeight = weighted.reduce((acc, w) => acc + w.weight, 0)
    if (totalWeight <= 0) return candidatePids[0]
    let rnd = Math.random() * totalWeight
    for (const { pid, weight } of weighted) {
      rnd -= weight
      if (rnd <= 0) {
        const entry = this.entries.get(pid)
        if (entry) entry.lastSelectedAt = nowMs
        return pid
      }
    }
    return candidatePids[candidatePids.length - 1]
  }

  resetWeights(): void {
    for (const entry of this.entries.values()) entry.lastSelectedAt = null
  }

  registeredPids(): ProviderId[] {
    return [...this.entries.keys()]
  }
}

const globalWeightedSelector = new WeightedProviderSelector()
for (const pid of listProviderIds()) globalWeightedSelector.register(pid)
export { globalWeightedSelector }
export type { WeightedProviderEntry }

// ---------------------------------------------------------------------------
// Provider alias registry — maps shorthand aliases to canonical provider IDs
// ---------------------------------------------------------------------------

const PROVIDER_ALIASES: Record<string, ProviderId> = {
  gpt: 'openai',
  claude: 'anthropic',
  gemini: 'google',
  ds: 'deepseek',
  r1: 'deepseek',
  qianwen: 'qwen',
  wenxin: 'ernie',
  baidu: 'ernie',
  tencent: 'hunyuan',
  kimi: 'moonshot',
  chatglm: 'zhipu',
  doubao_lite: 'doubao',
  minimax_t70: 'minimax',
  self_hosted: 'vllm',
  local: 'ollama',
}

function resolveAlias(alias: string): ProviderId | null {
  const lowered = alias.toLowerCase().replace(/[-\s]/g, '_')
  const canonical = PROVIDER_ALIASES[lowered]
  if (canonical) return canonical
  const directMatch = listProviderIds().find((pid) => pid === lowered)
  return directMatch ?? null
}

function expandAliases(aliases: string[]): ProviderId[] {
  const resolved: ProviderId[] = []
  for (const alias of aliases) {
    const pid = resolveAlias(alias)
    if (pid && !resolved.includes(pid)) resolved.push(pid)
  }
  return resolved
}

export { resolveAlias, expandAliases, PROVIDER_ALIASES }

// ---------------------------------------------------------------------------
// Circuit-breaker per provider — prevents cascading failures
// ---------------------------------------------------------------------------

type BreakerState = 'closed' | 'open' | 'half_open'

interface BreakerRecord {
  pid: ProviderId
  state: BreakerState
  failureCount: number
  lastFailedAt: number | null
  openedAt: number | null
  halfOpenAllowedAt: number | null
}

class ProviderCircuitBreaker {
  private records = new Map<ProviderId, BreakerRecord>()
  private readonly failureThreshold: number
  private readonly openDurationMs: number
  private readonly halfOpenProbeMs: number

  constructor(failureThreshold = 5, openDurationMs = 30_000, halfOpenProbeMs = 5_000) {
    this.failureThreshold = failureThreshold
    this.openDurationMs = openDurationMs
    this.halfOpenProbeMs = halfOpenProbeMs
  }

  private ensureRecord(pid: ProviderId): BreakerRecord {
    if (!this.records.has(pid)) {
      this.records.set(pid, {
        pid,
        state: 'closed',
        failureCount: 0,
        lastFailedAt: null,
        openedAt: null,
        halfOpenAllowedAt: null,
      })
    }
    return this.records.get(pid)!
  }

  isAllowed(pid: ProviderId): boolean {
    const rec = this.ensureRecord(pid)
    const nowMs = Date.now()
    if (rec.state === 'closed') return true
    if (rec.state === 'open') {
      if (rec.openedAt && nowMs - rec.openedAt >= this.openDurationMs) {
        rec.state = 'half_open'
        rec.halfOpenAllowedAt = nowMs
        return true
      }
      return false
    }
    if (rec.state === 'half_open') {
      return rec.halfOpenAllowedAt !== null && nowMs - rec.halfOpenAllowedAt >= this.halfOpenProbeMs
    }
    return false
  }

  onSuccess(pid: ProviderId): void {
    const rec = this.ensureRecord(pid)
    rec.state = 'closed'
    rec.failureCount = 0
    rec.openedAt = null
    rec.halfOpenAllowedAt = null
  }

  onFailure(pid: ProviderId): void {
    const rec = this.ensureRecord(pid)
    rec.failureCount++
    rec.lastFailedAt = Date.now()
    if (rec.state === 'half_open' || rec.failureCount >= this.failureThreshold) {
      rec.state = 'open'
      rec.openedAt = Date.now()
    }
  }

  stateFor(pid: ProviderId): BreakerState {
    return this.ensureRecord(pid).state
  }
  openProviders(): ProviderId[] {
    return [...this.records.entries()].filter(([, r]) => r.state === 'open').map(([pid]) => pid)
  }
  resetAll(): void {
    this.records.clear()
  }
}

const globalCircuitBreaker = new ProviderCircuitBreaker()
export { globalCircuitBreaker }
export type { BreakerState, BreakerRecord }

// ---------------------------------------------------------------------------
// Provider tier classification — groups providers by SLA tier
// ---------------------------------------------------------------------------

type ProviderTier = 'enterprise' | 'standard' | 'experimental' | 'selfhosted'

const TIER_ASSIGNMENTS: Record<ProviderId, ProviderTier> = {
  openai: 'enterprise',
  anthropic: 'enterprise',
  google: 'enterprise',
  qwen: 'enterprise',
  ernie: 'enterprise',
  deepseek: 'standard',
  hunyuan: 'standard',
  moonshot: 'standard',
  zhipu: 'standard',
  doubao: 'standard',
  minimax: 'experimental',
  vllm: 'selfhosted',
  ollama: 'selfhosted',
  // Coding-specialized providers inherit their base vendor's tier.
  'claude-coding': 'enterprise',
  'qwen-coding': 'enterprise',
  'qianfan-coding': 'enterprise',
  'kimi-coding': 'standard',
}

function getTierFor(pid: ProviderId): ProviderTier {
  return TIER_ASSIGNMENTS[pid] ?? 'experimental'
}

function getProvidersByTier(tier: ProviderTier): ProviderId[] {
  return listProviderIds().filter((pid) => getTierFor(pid) === tier)
}

export { getTierFor, getProvidersByTier }
export type { ProviderTier }

// ---------------------------------------------------------------------------
// Quota ledger — tracks token budget consumption per provider per period
// ---------------------------------------------------------------------------

interface QuotaPeriod {
  periodLabel: string
  allocatedTokens: number
  consumedTokens: number
  periodStartMs: number
  periodDurationMs: number
}

class ProviderQuotaLedger {
  private quotas = new Map<ProviderId, QuotaPeriod>()

  openPeriod(pid: ProviderId, label: string, allocatedTokens: number, durationMs: number): void {
    this.quotas.set(pid, {
      periodLabel: label,
      allocatedTokens,
      consumedTokens: 0,
      periodStartMs: Date.now(),
      periodDurationMs: durationMs,
    })
  }

  consume(pid: ProviderId, tokens: number): boolean {
    const quota = this.quotas.get(pid)
    if (!quota) return true
    const nowMs = Date.now()
    if (nowMs - quota.periodStartMs > quota.periodDurationMs) {
      quota.consumedTokens = 0
      quota.periodStartMs = nowMs
    }
    if (quota.consumedTokens + tokens > quota.allocatedTokens) return false
    quota.consumedTokens += tokens
    return true
  }

  remainingFor(pid: ProviderId): number {
    const quota = this.quotas.get(pid)
    if (!quota) return Number.POSITIVE_INFINITY
    return Math.max(0, quota.allocatedTokens - quota.consumedTokens)
  }

  utilizationFor(pid: ProviderId): number {
    const quota = this.quotas.get(pid)
    if (!quota || quota.allocatedTokens === 0) return 0
    return quota.consumedTokens / quota.allocatedTokens
  }

  exportSummary(): QuotaPeriod[] {
    return [...this.quotas.values()]
  }
  resetAll(): void {
    this.quotas.clear()
  }
}

const globalQuotaLedger = new ProviderQuotaLedger()
export { globalQuotaLedger }
export type { QuotaPeriod }

// ---------------------------------------------------------------------------
// Registry event bus — publishes provider lifecycle events to subscribers
// ---------------------------------------------------------------------------

type RegistryEventKind =
  | 'provider_initialized'
  | 'provider_failed'
  | 'provider_degraded'
  | 'provider_recovered'

interface RegistryEvent {
  kind: RegistryEventKind
  pid: ProviderId
  occurredAt: number
  detail?: string
}

type RegistryEventSubscriber = (evt: RegistryEvent) => void

class RegistryEventBus {
  private subscribers: RegistryEventSubscriber[] = []
  private history: RegistryEvent[] = []
  private readonly maxHistory: number

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory
  }

  subscribe(fn: RegistryEventSubscriber): () => void {
    this.subscribers.push(fn)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn)
    }
  }

  publish(kind: RegistryEventKind, pid: ProviderId, detail?: string): void {
    const evt: RegistryEvent = { kind, pid, occurredAt: Date.now(), detail }
    if (this.history.length >= this.maxHistory) this.history.shift()
    this.history.push(evt)
    for (const sub of this.subscribers) {
      try {
        sub(evt)
      } catch {
        /* isolate subscriber errors */
      }
    }
  }

  recentEvents(limitN = 50): RegistryEvent[] {
    return this.history.slice(-limitN)
  }
  eventsFor(pid: ProviderId): RegistryEvent[] {
    return this.history.filter((e) => e.pid === pid)
  }
  clearHistory(): void {
    this.history = []
  }
  subscriberCount(): number {
    return this.subscribers.length
  }
}

const globalRegistryBus = new RegistryEventBus()
export { globalRegistryBus }
export type { RegistryEvent, RegistryEventKind }

// ---------------------------------------------------------------------------
// Provider latency histogram — tracks p50/p95/p99 per provider
// ---------------------------------------------------------------------------

class ProviderLatencyHistogram {
  private samples = new Map<ProviderId, number[]>()
  private readonly maxSamplesPerProvider: number

  constructor(maxSamplesPerProvider = 100) {
    this.maxSamplesPerProvider = maxSamplesPerProvider
  }

  record(pid: ProviderId, latencyMs: number): void {
    const arr = this.samples.get(pid) ?? []
    arr.push(latencyMs)
    if (arr.length > this.maxSamplesPerProvider) arr.shift()
    this.samples.set(pid, arr)
  }

  percentile(pid: ProviderId, pct: number): number {
    const arr = this.samples.get(pid)
    if (!arr || arr.length === 0) return 0
    const sorted = [...arr].sort((x, y) => x - y)
    const idx = Math.floor(sorted.length * pct)
    return sorted[Math.min(idx, sorted.length - 1)]
  }

  p50(pid: ProviderId): number {
    return this.percentile(pid, 0.5)
  }
  p95(pid: ProviderId): number {
    return this.percentile(pid, 0.95)
  }
  p99(pid: ProviderId): number {
    return this.percentile(pid, 0.99)
  }

  fastestProvider(candidatePids: ProviderId[]): ProviderId | null {
    if (candidatePids.length === 0) return null
    return candidatePids.reduce((best, pid) => {
      const bestP50 = this.p50(best)
      const pidP50 = this.p50(pid)
      return pidP50 < bestP50 ? pid : best
    })
  }

  exportStats(): Record<string, { p50: number; p95: number; p99: number; sampleCount: number }> {
    const out: Record<string, { p50: number; p95: number; p99: number; sampleCount: number }> = {}
    for (const [pid, arr] of this.samples) {
      out[pid] = {
        p50: this.p50(pid),
        p95: this.p95(pid),
        p99: this.p99(pid),
        sampleCount: arr.length,
      }
    }
    return out
  }

  resetAll(): void {
    this.samples.clear()
  }
}

const globalLatencyHistogram = new ProviderLatencyHistogram()
export { globalLatencyHistogram }

// ---------------------------------------------------------------------------
// Registry snapshot exporter — serialises registry state for diagnostics
// ---------------------------------------------------------------------------

interface RegistryDiagnosticSnapshot {
  meta: RegistryMeta
  providerIds: ProviderId[]
  domesticProviders: ProviderId[]
  healthSummary: ProviderHealthRecord[]
  usageSummary: UsageSnapshot[]
  circuitBreakerOpen: ProviderId[]
  quotaSummary: QuotaPeriod[]
  recentEvents: RegistryEvent[]
  latencyStats: Record<string, { p50: number; p95: number; p99: number; sampleCount: number }>
  capturedAt: number
}

export function exportRegistryDiagnostics(): RegistryDiagnosticSnapshot {
  return {
    meta: getRegistryMeta(),
    providerIds: listProviderIds(),
    domesticProviders: getDomesticProviders(),
    healthSummary: globalHealthLedger.exportSummary(),
    usageSummary: globalUsageCounters.exportAll(),
    circuitBreakerOpen: globalCircuitBreaker.openProviders(),
    quotaSummary: globalQuotaLedger.exportSummary(),
    recentEvents: globalRegistryBus.recentEvents(20),
    latencyStats: globalLatencyHistogram.exportStats(),
    capturedAt: Date.now(),
  }
}

export type { RegistryDiagnosticSnapshot }

// ---------------------------------------------------------------------------
// Retry budget — tracks remaining retries per provider per time window
// ---------------------------------------------------------------------------

class ProviderRetryBudget {
  private budgets = new Map<
    ProviderId,
    { remaining: number; windowStart: number; windowMs: number; maxRetries: number }
  >()

  allocate(pid: ProviderId, maxRetries: number, windowMs: number): void {
    this.budgets.set(pid, { remaining: maxRetries, windowStart: Date.now(), windowMs, maxRetries })
  }

  consume(pid: ProviderId): boolean {
    const budget = this.budgets.get(pid)
    if (!budget) return true
    const nowMs = Date.now()
    if (nowMs - budget.windowStart >= budget.windowMs) {
      budget.remaining = budget.maxRetries
      budget.windowStart = nowMs
    }
    if (budget.remaining <= 0) return false
    budget.remaining--
    return true
  }

  remainingFor(pid: ProviderId): number {
    const budget = this.budgets.get(pid)
    if (!budget) return Number.POSITIVE_INFINITY
    return budget.remaining
  }

  exhaustedProviders(): ProviderId[] {
    return [...this.budgets.entries()].filter(([, b]) => b.remaining <= 0).map(([pid]) => pid)
  }

  resetAll(): void {
    this.budgets.clear()
  }
}

const globalRetryBudget = new ProviderRetryBudget()
for (const pid of listProviderIds()) globalRetryBudget.allocate(pid, 3, 60_000)
export { globalRetryBudget }

// ---------------------------------------------------------------------------
// Fallback chain resolver — ordered fallback sequence per primary provider
// ---------------------------------------------------------------------------

const FALLBACK_CHAINS: Partial<Record<ProviderId, ProviderId[]>> = {
  openai: ['anthropic', 'google', 'deepseek'],
  anthropic: ['openai', 'google'],
  google: ['openai', 'anthropic'],
  qwen: ['deepseek', 'ernie', 'hunyuan'],
  ernie: ['qwen', 'deepseek', 'moonshot'],
  deepseek: ['qwen', 'openai'],
  hunyuan: ['qwen', 'doubao', 'ernie'],
  moonshot: ['qwen', 'zhipu', 'deepseek'],
  zhipu: ['moonshot', 'qwen', 'deepseek'],
  doubao: ['hunyuan', 'qwen'],
  minimax: ['qwen', 'moonshot'],
  vllm: ['ollama'],
  ollama: ['vllm'],
}

function getFallbackChain(primaryPid: ProviderId, excludePids: ProviderId[] = []): ProviderId[] {
  const chain = FALLBACK_CHAINS[primaryPid] ?? []
  const excluded = new Set(excludePids)
  return chain.filter((pid) => !excluded.has(pid) && globalCircuitBreaker.isAllowed(pid))
}

function resolveWithFallback(
  primaryPid: ProviderId,
  excludePids: ProviderId[] = []
): ProviderId | null {
  if (globalCircuitBreaker.isAllowed(primaryPid) && !excludePids.includes(primaryPid))
    return primaryPid
  const fallbacks = getFallbackChain(primaryPid, [primaryPid, ...excludePids])
  return fallbacks[0] ?? null
}

export { getFallbackChain, resolveWithFallback, FALLBACK_CHAINS }

// ---------------------------------------------------------------------------
// Provider affinity scorer — prefers low-latency, healthy providers
// ---------------------------------------------------------------------------

interface AffinityFactors {
  latencyWeight: number
  healthWeight: number
  quotaWeight: number
  circuitWeight: number
}

const DEFAULT_AFFINITY_FACTORS: AffinityFactors = {
  latencyWeight: 0.4,
  healthWeight: 0.3,
  quotaWeight: 0.2,
  circuitWeight: 0.1,
}

function computeAffinityScore(
  pid: ProviderId,
  factors: AffinityFactors = DEFAULT_AFFINITY_FACTORS
): number {
  const latencyScore = (() => {
    const p50 = globalLatencyHistogram.p50(pid)
    if (p50 === 0) return 0.5
    const normalized = Math.min(p50 / 5000, 1)
    return 1 - normalized
  })()
  const healthScore = (() => {
    const rec = globalHealthLedger.exportSummary().find((h) => h.pid === pid)
    if (!rec) return 0.5
    return rec.consecutiveFailures === 0 ? 1 : Math.max(0, 1 - rec.consecutiveFailures * 0.2)
  })()
  const quotaScore = (() => {
    const util = globalQuotaLedger.utilizationFor(pid)
    return Math.max(0, 1 - util)
  })()
  const circuitScore = globalCircuitBreaker.isAllowed(pid) ? 1 : 0

  return (
    latencyScore * factors.latencyWeight +
    healthScore * factors.healthWeight +
    quotaScore * factors.quotaWeight +
    circuitScore * factors.circuitWeight
  )
}

function rankProvidersByAffinity(
  candidatePids: ProviderId[],
  factors?: AffinityFactors
): ProviderId[] {
  return [...candidatePids].sort(
    (a, b) => computeAffinityScore(b, factors) - computeAffinityScore(a, factors)
  )
}

function topAffinityProvider(
  candidatePids: ProviderId[],
  factors?: AffinityFactors
): ProviderId | null {
  const ranked = rankProvidersByAffinity(candidatePids, factors)
  return ranked[0] ?? null
}

export {
  computeAffinityScore,
  rankProvidersByAffinity,
  topAffinityProvider,
  DEFAULT_AFFINITY_FACTORS,
}
export type { AffinityFactors }

// ---------------------------------------------------------------------------
// Provider cohort manager — groups providers for A/B experimentation
// ---------------------------------------------------------------------------

interface CohortSpec {
  cohortId: string
  memberPids: ProviderId[]
  trafficFraction: number
  description?: string
}

class ProviderCohortManager {
  private cohorts = new Map<string, CohortSpec>()

  register(spec: CohortSpec): void {
    this.cohorts.set(spec.cohortId, { ...spec })
  }

  unregister(cohortId: string): boolean {
    return this.cohorts.delete(cohortId)
  }

  getCohort(cohortId: string): CohortSpec | undefined {
    return this.cohorts.get(cohortId)
  }

  membersOf(cohortId: string): ProviderId[] {
    return this.cohorts.get(cohortId)?.memberPids ?? []
  }

  cohortsFor(pid: ProviderId): string[] {
    return [...this.cohorts.values()]
      .filter((spec) => spec.memberPids.includes(pid))
      .map((spec) => spec.cohortId)
  }

  activeCohorts(): CohortSpec[] {
    return [...this.cohorts.values()].filter((spec) => spec.trafficFraction > 0)
  }

  sampleCohortMember(cohortId: string): ProviderId | null {
    const members = this.membersOf(cohortId)
    if (members.length === 0) return null
    const ranked = rankProvidersByAffinity(members)
    return ranked[0] ?? null
  }

  exportAll(): CohortSpec[] {
    return [...this.cohorts.values()]
  }
}

const globalCohortManager = new ProviderCohortManager()
export { globalCohortManager }
export type { CohortSpec }

// ---------------------------------------------------------------------------
// Provider token cost estimator — estimates cost per 1k tokens
// ---------------------------------------------------------------------------

interface TokenCostRate {
  pid: ProviderId
  inputCostPer1k: number
  outputCostPer1k: number
  currencyCode: string
}

class ProviderCostEstimator {
  private rates = new Map<ProviderId, TokenCostRate>()

  setRate(rate: TokenCostRate): void {
    this.rates.set(rate.pid, { ...rate })
  }

  estimateCost(pid: ProviderId, inputTokens: number, outputTokens: number): number {
    const rate = this.rates.get(pid)
    if (!rate) return 0
    return (inputTokens / 1000) * rate.inputCostPer1k + (outputTokens / 1000) * rate.outputCostPer1k
  }

  cheapestProvider(
    candidatePids: ProviderId[],
    inputTokens: number,
    outputTokens: number
  ): ProviderId | null {
    if (candidatePids.length === 0) return null
    return candidatePids.reduce((cheapest, pid) => {
      const cheapestCost = this.estimateCost(cheapest, inputTokens, outputTokens)
      const pidCost = this.estimateCost(pid, inputTokens, outputTokens)
      return pidCost < cheapestCost ? pid : cheapest
    })
  }

  exportRates(): TokenCostRate[] {
    return [...this.rates.values()]
  }
  clearRates(): void {
    this.rates.clear()
  }

  ratesForCurrency(currencyCode: string): TokenCostRate[] {
    return [...this.rates.values()].filter((r) => r.currencyCode === currencyCode)
  }
}

const globalCostEstimator = new ProviderCostEstimator()
export { globalCostEstimator }
export type { TokenCostRate }
