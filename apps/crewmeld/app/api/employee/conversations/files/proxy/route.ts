/**
 * MinIO file proxy endpoint — extract key from presigned URL, read via S3 client on internal network
 *
 * GET /api/employee/conversations/files/proxy?url=<base64url-encoded MinIO URL>
 *
 * Used for tool-generated files (charts, exports, etc.) whose presigned URLs
 * Logic:
 * 1. Decode URL, verify host is a known MinIO address
 * 2. Extract bucket and object key from URL path
 * 3. Read file directly using S3 client (internal MINIO_ENDPOINT)
 */

import type { Readable } from 'stream'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createLogger } from '@crewmeld/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { apiErr } from '@/lib/api/response'
import { getSession } from '@/lib/auth'

const logger = createLogger('MinioProxy')

/** Extract host:port from URL */
function extractHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

/** Dynamically read all known MinIO hosts */
function getAllowedHosts(): Set<string> {
  const endpoint = (process.env.MINIO_ENDPOINT ?? '').trim()
  const external = (process.env.MINIO_EXTERNAL_ENDPOINT ?? '').trim()
  const publicUrl = (process.env.MINIO_PUBLIC_URL ?? '').trim()
  return new Set([endpoint, external, publicUrl].map(extractHost).filter(Boolean))
}

/** Get S3 client (using internal MINIO_ENDPOINT) */
let _client: S3Client | null = null
function getClient(): S3Client {
  if (_client) return _client
  _client = new S3Client({
    endpoint: (process.env.MINIO_ENDPOINT ?? '').trim(),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: (process.env.MINIO_ACCESS_KEY ?? '').trim(),
      secretAccessKey: (process.env.MINIO_SECRET_KEY ?? '').trim(),
    },
  })
  return _client
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session?.user) {
    return apiErr('api.common.unauthorized', { status: 401 })
  }

  const encodedUrl = request.nextUrl.searchParams.get('url')
  if (!encodedUrl) {
    return apiErr('api.files.missingUrl', { status: 400 })
  }

  let targetUrl: string
  try {
    targetUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8')
  } catch {
    return apiErr('api.files.invalidUrlEncoding', { status: 400 })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    return apiErr('api.files.invalidUrl', { status: 400 })
  }

  // Security check: only allow known MinIO addresses
  const allowedHosts = getAllowedHosts()
  if (!allowedHosts.has(parsedUrl.host)) {
    logger.warn('Rejected non-MinIO proxy address', {
      host: parsedUrl.host,
      allowedHosts: [...allowedHosts],
    })
    return apiErr('api.files.proxyNotAllowed', { status: 403 })
  }

  // Extract bucket and key from path
  // Path format: /{bucket}/{key...}  e.g. /tool-files/charts/chart_xxx.png
  // URL.pathname keeps percent-encoded chars (e.g. %E8%8D%AF for 药) — decode per
  // segment so the resulting S3 key matches what MinIO actually stored.
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean)
  if (pathParts.length < 2) {
    return apiErr('api.files.invalidFilePath', { status: 400 })
  }

  let bucket: string
  let key: string
  try {
    bucket = decodeURIComponent(pathParts[0])
    key = pathParts.slice(1).map(decodeURIComponent).join('/')
  } catch {
    return apiErr('api.files.invalidFilePath', { status: 400 })
  }

  try {
    const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }))

    const contentType = result.ContentType ?? 'application/octet-stream'

    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=86400',
    })

    if (result.ContentLength && result.ContentLength > 0) {
      headers.set('Content-Length', String(result.ContentLength))
    }

    // Node.js Readable → Web ReadableStream
    const body = result.Body
    const stream =
      body instanceof ReadableStream
        ? body
        : new ReadableStream({
            start(controller) {
              const readable = body as NodeJS.ReadableStream
              ;(readable as Readable).on('data', (chunk: Buffer) => controller.enqueue(chunk))
              ;(readable as Readable).on('end', () => controller.close())
              ;(readable as Readable).on('error', (err) => controller.error(err))
            },
          })

    return new NextResponse(stream, { status: 200, headers })
  } catch (err) {
    logger.error('MinIO file read failed', { bucket, key, error: (err as Error).message })
    return apiErr('api.files.readFailed', { status: 404 })
  }
}
