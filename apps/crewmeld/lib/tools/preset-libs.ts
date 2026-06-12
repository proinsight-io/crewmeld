import { createHash } from 'node:crypto'
import _ from 'lodash'
import dayjs from 'dayjs'
import { z } from 'zod'

/**
 * Whitelisted libraries injected as globals into the API-tool sandbox. Admin
 * extension point: add entries here (or load from config) to widen the allowlist.
 */
export function buildPresetLibs(): Record<string, unknown> {
  return {
    _,
    dayjs,
    z,
    crypto: {
      sha256: (s: string) => createHash('sha256').update(s).digest('hex'),
      md5: (s: string) => createHash('md5').update(s).digest('hex'),
      base64Encode: (s: string) => Buffer.from(s).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    },
  }
}
