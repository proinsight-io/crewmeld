import { createHmac, timingSafeEqual } from 'node:crypto'

export const QA_VALIDATION_SCHEMA_VERSION = '1'
const TOKEN_TTL_MS = 5 * 60_000

interface TokenPayload {
  knowledgeBaseId: string
  digest: string
  schemaVersion: string
  actorId: string
  expiresAt: number
}

function secret(): string {
  const value =
    process.env.INTERNAL_API_SECRET ?? process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET
  if (!value)
    throw new Error(
      'QA import tokens require INTERNAL_API_SECRET, BETTER_AUTH_SECRET, or AUTH_SECRET.'
    )
  return value
}

function encode(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}
function signingKey(): Buffer {
  return createHmac('sha256', secret()).update('crewmeld:qa-import:key:v1').digest()
}
function signature(payload: string): string {
  return createHmac('sha256', signingKey())
    .update(`crewmeld:qa-import:token:v1:${payload}`)
    .digest('base64url')
}

export function signQaImportToken(
  input: Omit<TokenPayload, 'schemaVersion' | 'expiresAt'>,
  now = Date.now()
): string {
  if (!input.actorId) throw new Error('QA import tokens require an authenticated actor.')
  const payload = encode({
    ...input,
    schemaVersion: QA_VALIDATION_SCHEMA_VERSION,
    expiresAt: now + TOKEN_TTL_MS,
  })
  return `${payload}.${signature(payload)}`
}

export function verifyQaImportToken(
  token: string,
  expected: Omit<TokenPayload, 'schemaVersion' | 'expiresAt'>,
  now = Date.now()
): boolean {
  if (!expected.actorId) return false
  try {
    const [payload, presented, extra] = token.split('.')
    if (!payload || !presented || extra) return false
    const a = Buffer.from(signature(payload))
    const b = Buffer.from(presented)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload
    return (
      parsed.expiresAt > now &&
      parsed.schemaVersion === QA_VALIDATION_SCHEMA_VERSION &&
      parsed.knowledgeBaseId === expected.knowledgeBaseId &&
      parsed.digest === expected.digest &&
      parsed.actorId === expected.actorId
    )
  } catch {
    return false
  }
}
