/**
 * Real-time IM → ScopeIdentity resolver.
 *
 * Resolves the caller's {@link ScopeIdentity} from their IM channel user id by
 * fetching directory detail from the relevant channel API and mapping it to the
 * platform identity shape.  Credentials are looked up from the system-default
 * connection for the given channel type; if no credential is configured the
 * call fails closed (returns null).
 *
 * Results are cached two levels deep — an in-process L1 backed by a shared Redis
 * L2 — so the IM API is not hit on every message, and the cache is shared across
 * replicas. Both tiers share one TTL, configurable via {@link cacheTtlSeconds}
 * (env `IDENTITY_CACHE_TTL_SECONDS`, default 5 min). Redis is best-effort: when
 * it is unavailable the resolver degrades to L1-only.
 */

import { createLogger } from '@crewmeld/logger'
import type { ChannelUserDetail } from '@/lib/channels/directory-types'
import { env } from '@/lib/core/config/env'
import { getRedisClient } from '@/lib/core/config/redis'
import type { ChannelIdentityInput, ScopeIdentity } from './types'

const logger = createLogger('ChannelIdentity')

/** Redis key namespace for cached identities. */
const REDIS_PREFIX = 'identity:'

/** Default cache TTL when unconfigured / invalid: 5 minutes (seconds). */
const DEFAULT_TTL_S = 5 * 60

/**
 * Cache TTL in seconds, shared by the L1 and L2 tiers. Configurable via the
 * `IDENTITY_CACHE_TTL_SECONDS` env var; falls back to {@link DEFAULT_TTL_S}
 * when unset or not a positive number. Read per call so env changes take effect
 * without a restart.
 */
function cacheTtlSeconds(): number {
  const v = Number(env.IDENTITY_CACHE_TTL_SECONDS)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_S
}

interface CacheEntry {
  value: ScopeIdentity | null
  at: number
}

/** L1: in-process cache, fastest tier; backed by the L2 Redis tier below. */
const cache = new Map<string, CacheEntry>()

/** Namespaced Redis key for an L1 cache key. */
function redisKey(key: string): string {
  return `${REDIS_PREFIX}${key}`
}

/**
 * Read a cached identity from L2 (Redis). Best-effort: returns `{ hit: false }`
 * when Redis is unavailable or the read fails, so the caller falls through to
 * the upstream fetch. A stored `"null"` is a cached not-found (`hit: true,
 * value: null`) — distinct from a key miss (`hit: false`).
 */
async function readL2(key: string): Promise<{ hit: boolean; value: ScopeIdentity | null }> {
  const redis = getRedisClient()
  if (!redis) return { hit: false, value: null }
  try {
    const raw = await redis.get(redisKey(key))
    if (raw === null) return { hit: false, value: null }
    return { hit: true, value: JSON.parse(raw) as ScopeIdentity | null }
  } catch (err) {
    logger.warn('channel identity L2 read failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
    return { hit: false, value: null }
  }
}

/**
 * Write a resolved identity to L2 (Redis) under the shared TTL. Best-effort: a
 * missing client or a failed write is swallowed — L1 still serves the value.
 */
async function writeL2(key: string, value: ScopeIdentity | null): Promise<void> {
  const redis = getRedisClient()
  if (!redis) return
  try {
    await redis.set(redisKey(key), JSON.stringify(value), 'EX', cacheTtlSeconds())
  } catch (err) {
    logger.warn('channel identity L2 write failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Clears the identity cache.
 *
 * @internal Test-only — do not call from production code.
 */
export function __clearIdentityCache(): void {
  cache.clear()
}

/**
 * Resolve a caller's {@link ScopeIdentity} from their IM channel in real time.
 *
 * Maps channel user detail to `{ employeeId=userId, positions, scope.orgUnitIds }`.
 * Returns `null` on unknown channel, missing credentials, fetch failure, or
 * user-not-found (callers fail-closed).
 *
 * @param input - Channel kind and channel-native user id.
 * @param now   - Clock injection (seconds); defaults to `Date.now`.
 */
export async function resolveChannelIdentity(
  input: ChannelIdentityInput,
  now: () => number = Date.now
): Promise<ScopeIdentity | null> {
  const key = `${input.channel}:${input.userId}`
  // L1 — in-process, fastest tier.
  const hit = cache.get(key)
  if (hit && now() - hit.at < cacheTtlSeconds() * 1000) return hit.value

  // L2 — shared Redis tier (best-effort). On hit, backfill L1 and return.
  const l2 = await readL2(key)
  if (l2.hit) {
    cache.set(key, { value: l2.value, at: now() })
    return l2.value
  }

  try {
    const detail = await fetchDetail(input.channel, input.userId, input.config)
    // fetchDetail returns null for stable non-retry conditions (unknown channel,
    // missing credentials, user-not-found).  Both the non-null and null return
    // paths represent definite facts worth caching.
    const value: ScopeIdentity | null = detail
      ? {
          employeeId: input.userId,
          positions: detail.positions ?? [],
          employeeNo: detail.employeeNo,
          leaderId: detail.leaderId,
          scope: { orgUnitIds: detail.orgUnitIds ?? [] },
          raw: detail,
        }
      : null
    cache.set(key, { value, at: now() })
    await writeL2(key, value)
    return value
  } catch (err) {
    // fetchDetail threw — transient failure (network blip, IM API error).
    // Do NOT cache (neither L1 nor L2): let the next call retry the upstream API.
    logger.warn('channel identity resolve failed', {
      channel: input.channel,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch directory detail for `userId` on `channel`, using the credentials of the
 * connection that actually received the message (threaded down from the webhook
 * via `_meta` → resolveChannelIdentity).
 *
 * There is NO system-default fallback: the receiving app is known end-to-end, so
 * if no usable config is supplied this returns null rather than guessing a
 * different (possibly wrong / unpermissioned) app.
 *
 * Returns `null` when the channel is unknown, no config is supplied, or the
 * required credentials are missing.
 */
async function fetchDetail(
  channel: string,
  userId: string,
  config?: Record<string, unknown>
): Promise<ChannelUserDetail | null> {
  if (!config) {
    logger.warn('channel identity: no connection config supplied; skipping (no fallback)', {
      channel,
    })
    return null
  }

  switch (channel) {
    case 'feishu': {
      const appId = config.appId as string | undefined
      const appSecret = config.appSecret as string | undefined
      if (!appId || !appSecret) {
        logger.warn('feishu credentials missing or incomplete', { channel })
        return null
      }
      const { getFeishuUserDetail } = await import('@/lib/channels/feishu-client')
      return getFeishuUserDetail(appId, appSecret, userId)
    }

    case 'dingtalk': {
      const appKey = config.appKey as string | undefined
      const appSecret = config.appSecret as string | undefined
      if (!appKey || !appSecret) {
        logger.warn('dingtalk credentials missing or incomplete', { channel })
        return null
      }
      const { getDingtalkUserDetail } = await import('@/lib/channels/dingtalk-client')
      return getDingtalkUserDetail(appKey, appSecret, userId)
    }

    case 'wecom': {
      const corpId = config.corpId as string | undefined
      const corpSecret = config.corpSecret as string | undefined
      if (!corpId || !corpSecret) {
        logger.warn('wecom credentials missing or incomplete', { channel })
        return null
      }
      const { getWecomUserDetail } = await import('@/lib/channels/wecom/directory')
      return getWecomUserDetail(corpId, corpSecret, userId)
    }

    default:
      logger.warn('unsupported channel for identity resolution', { channel })
      return null
  }
}
