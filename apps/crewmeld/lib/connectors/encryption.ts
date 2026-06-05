import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { createLogger } from '@crewmeld/logger'

const logger = createLogger('ConnectorEncryption')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const SALT_LENGTH = 32

const DEV_FALLBACK_KEY = 'crewmeld-dev-connector-key-do-not-use-in-prod'

let _warnedMissingKey = false

function getEncryptionKey(): string {
  const key = process.env.CONNECTOR_ENCRYPTION_KEY
  if (!key) {
    if (!_warnedMissingKey) {
      logger.warn(
        'CONNECTOR_ENCRYPTION_KEY not configured, using dev default. Do not use in production!'
      )
      _warnedMissingKey = true
    }
    return DEV_FALLBACK_KEY
  }
  return key
}

/**
 * Encrypt connection config using AES-256-GCM
 * @returns Encrypted string (format: salt:iv:authTag:ciphertext, all base64)
 */
export function encryptConfig(plaintext: string): string {
  const encryptionKey = getEncryptionKey()
  const salt = randomBytes(SALT_LENGTH)
  const key = scryptSync(encryptionKey, salt, 32)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  const authTag = cipher.getAuthTag()

  return [
    salt.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted,
  ].join(':')
}

/**
 * Decrypt connection config
 * @returns Decrypted plaintext JSON string
 */
export function decryptConfig(ciphertext: string): string {
  const encryptionKey = getEncryptionKey()
  const [saltB64, ivB64, authTagB64, encrypted] = ciphertext.split(':')

  const salt = Buffer.from(saltB64, 'base64')
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const key = scryptSync(encryptionKey, salt, 32)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted, 'base64', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * Mask sensitive fields in config object (for API response)
 */
export function maskSensitiveFields(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    'corpSecret',
    'appSecret',
    'appKey',
    'apiKey',
    'password',
    'difyAppApiKey',
    'accessKeySecret',
    'secretKey',
    'accessKeyId',
    'encodingAESKey',
    'token',
    'telegramBotToken',
    'telegramWebhookSecret',
    'n8nApiKey',
  ]
  const masked = { ...config }

  for (const key of sensitiveKeys) {
    if (typeof masked[key] === 'string' && (masked[key] as string).length > 0) {
      const value = masked[key] as string
      if (value.length <= 8) {
        masked[key] = '****'
      } else {
        masked[key] = `${value.slice(0, 4)}****${value.slice(-4)}`
      }
    }
  }

  // OpenClaw endpoints array: mask the per-entry `token` field.
  if (Array.isArray(masked.endpoints)) {
    masked.endpoints = (masked.endpoints as unknown[]).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const e = { ...(entry as Record<string, unknown>) }
      if (typeof e.token === 'string' && (e.token as string).length > 0) {
        const v = e.token as string
        e.token = v.length <= 8 ? '****' : `${v.slice(0, 4)}****${v.slice(-4)}`
      }
      return e
    })
  }

  return masked
}
