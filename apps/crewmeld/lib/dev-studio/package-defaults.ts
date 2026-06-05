/**
 * Defaults applied to a parsed manifest before sandbox provisioning.
 *
 * The K8s-style {requests, limits} split + 'ephemeral-storage' key naming
 * mirrors `apps/crewmeld/lib/k8s/deploy-skill.ts:1152` so a future migration
 * from OpenSandbox to K8s can read the same field names without re-shaping.
 *
 * Python-only for now — `image` default reflects the small slim variant
 * (alpine is rejected because PyMySQL and some wheels break on musl libc).
 */

import type { ManifestT } from './manifest-reader'

export const DEFAULT_IMAGE = 'python:3.12-slim'

export const DEFAULT_RESOURCES = {
  requests: {
    cpu: '100m',
    memory: '128Mi',
    'ephemeral-storage': '512Mi',
  },
  limits: {
    cpu: '500m',
    memory: '512Mi',
    'ephemeral-storage': '1Gi',
  },
} as const

/**
 * Fill any missing image / resources fields with the project defaults.
 * Behavior parity with K8s: if only `limits` is supplied, `requests` is
 * mirrored from it. Per-field gaps (e.g. limits.cpu present, limits.memory
 * absent) are filled individually.
 */
export function applyManifestDefaults(m: ManifestT): ManifestT {
  const image = m.image ?? DEFAULT_IMAGE

  const explicitRequests = m.resources?.requests
  const explicitLimits = m.resources?.limits

  const mergedLimits = {
    cpu: explicitLimits?.cpu ?? DEFAULT_RESOURCES.limits.cpu,
    memory: explicitLimits?.memory ?? DEFAULT_RESOURCES.limits.memory,
    'ephemeral-storage':
      explicitLimits?.['ephemeral-storage'] ?? DEFAULT_RESOURCES.limits['ephemeral-storage'],
  }

  // K8s behavior: when requests omitted, default to limits
  const requestsBase =
    explicitRequests ?? (explicitLimits ? mergedLimits : DEFAULT_RESOURCES.requests)
  const mergedRequests = {
    cpu: requestsBase.cpu ?? DEFAULT_RESOURCES.requests.cpu,
    memory: requestsBase.memory ?? DEFAULT_RESOURCES.requests.memory,
    'ephemeral-storage':
      requestsBase['ephemeral-storage'] ?? DEFAULT_RESOURCES.requests['ephemeral-storage'],
  }

  return {
    ...m,
    image,
    resources: { requests: mergedRequests, limits: mergedLimits },
  }
}
