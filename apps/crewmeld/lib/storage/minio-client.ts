/**
 * Shared MinIO (S3 compatible) client.
 *
 * Centralizes endpoint and credential reading so the conversation file
 * storage layer and the SOP workspace layer reuse the same connection
 * plumbing instead of duplicating client construction in each module.
 *
 * Two clients are exposed:
 *
 * - {@link getMinioClient} — uses `MINIO_ENDPOINT`, the address the
 *   Next.js process itself reaches MinIO on.
 *
 * - {@link getExternalMinioClient} — uses `MINIO_EXTERNAL_ENDPOINT` when
 *   set, falling back to `MINIO_ENDPOINT`. Used when generating presigned
 *   URLs that need to be reachable from the K8s tool pods or external
 *   browsers (signing host must match the host the client will actually
 *   connect to, otherwise the signature is rejected).
 */

import { S3Client } from '@aws-sdk/client-s3'

const MINIO_ENDPOINT = (process.env.MINIO_ENDPOINT ?? '').trim()
const MINIO_ACCESS_KEY = (process.env.MINIO_ACCESS_KEY ?? '').trim()
const MINIO_SECRET_KEY = (process.env.MINIO_SECRET_KEY ?? '').trim()
const MINIO_EXTERNAL_ENDPOINT = (process.env.MINIO_EXTERNAL_ENDPOINT ?? '').trim()

/** Bucket holding conversation attachments and SOP workspaces. */
export const MINIO_BUCKET = (process.env.MINIO_BUCKET ?? 'tool-files').trim()

/**
 * Endpoint reachable from tool Pods. Falls back to {@link MINIO_ENDPOINT}
 * when no external override is configured.
 */
export const TOOL_POD_ENDPOINT = MINIO_EXTERNAL_ENDPOINT || MINIO_ENDPOINT

let _client: S3Client | null = null
let _externalClient: S3Client | null = null

/** Client used by the Next.js process to read/write MinIO. */
export function getMinioClient(): S3Client {
  if (_client) return _client
  _client = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY,
      secretAccessKey: MINIO_SECRET_KEY,
    },
  })
  return _client
}

/**
 * Client whose signing host matches the address tool Pods (or external
 * browsers) actually reach. Returns the internal client when no external
 * endpoint override is configured.
 */
export function getExternalMinioClient(): S3Client {
  if (!MINIO_EXTERNAL_ENDPOINT || MINIO_EXTERNAL_ENDPOINT === MINIO_ENDPOINT) {
    return getMinioClient()
  }
  if (_externalClient) return _externalClient
  _externalClient = new S3Client({
    endpoint: MINIO_EXTERNAL_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY,
      secretAccessKey: MINIO_SECRET_KEY,
    },
  })
  return _externalClient
}

/**
 * Raw credentials for callers that need to forward MinIO config elsewhere
 * (e.g. the K8s deploy module injecting them into the rclone sidecar env).
 */
export function getMinioCredentials(): {
  endpoint: string
  externalEndpoint: string
  accessKey: string
  secretKey: string
  bucket: string
} {
  return {
    endpoint: MINIO_ENDPOINT,
    externalEndpoint: MINIO_EXTERNAL_ENDPOINT || MINIO_ENDPOINT,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
    bucket: MINIO_BUCKET,
  }
}
