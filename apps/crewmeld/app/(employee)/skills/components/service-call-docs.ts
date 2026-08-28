import { buildServiceAccessUrl } from '@/lib/tools/service-access-url'
import {
  buildCurlExample,
  type CurlAuthMode,
  type CurlMethod,
  type CurlServiceType,
  type ToolParameters,
} from './api-key-curl'

export interface ServiceCallDescriptor {
  instanceId: string
  serviceType: CurlServiceType
  method: CurlMethod
  authMode: CurlAuthMode
  visibility: 'internal' | 'public'
  currentOrigin: string
  customDomain?: string | null
  sharedPublicUrl?: string
  parameters?: ToolParameters | null
}

export interface ServiceCallDocs {
  endpoint: string
  method: CurlMethod
  curl: string
  browserUrl?: string
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Build protocol-aware invocation documentation for one published service. */
export function buildServiceCallDocs(input: ServiceCallDescriptor): ServiceCallDocs {
  const method: CurlMethod = input.serviceType === 'json' ? 'POST' : input.method
  const endpoint =
    input.serviceType === 'json'
      ? `${withoutTrailingSlash(input.currentOrigin)}/api/tools/${input.instanceId}/invoke`
      : buildServiceAccessUrl({
          instanceId: input.instanceId,
          visibility: input.visibility,
          internalBaseUrl: input.currentOrigin,
          customDomain: input.customDomain,
          sharedPublicUrl: input.sharedPublicUrl,
        })
  const curl = buildCurlExample({
    endpoint,
    parameters: input.parameters,
    apiKey: input.authMode === 'api-key' ? 'YOUR_API_KEY' : undefined,
    method,
    serviceType: input.serviceType,
    authMode: input.authMode,
  })

  return {
    endpoint,
    method,
    curl,
    browserUrl: input.serviceType === 'http' && method === 'GET' ? endpoint : undefined,
  }
}
