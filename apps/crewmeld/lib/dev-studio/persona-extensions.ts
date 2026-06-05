/**
 * Persona prompt dispatcher for the dev-studio chat session bootstrap.
 *
 * The first user message of a session is wrapped with the full A+B persona
 * prompt before being forwarded to claude-cli — see use-stream-chat.ts.
 * The prompt body lives under `apps/crewmeld/locales/prompts/`, one file
 * per locale, so prompt content follows the same i18n contract as UI
 * labels: operator locale=zh → AI gets the Chinese prompt and replies in
 * Chinese; locale=en → English prompt + English replies.
 *
 * Token literals like `<phase>` / `<pipeline>` / `<ask>` / `<title>` and
 * manifest field names (`connectorType` / `needsFileMount` / `_sopFileDir`
 * ...) are wire-protocol identifiers and remain identical across locales.
 */
import type { Locale } from '@/locales'
import { DEV_STUDIO_PERSONA_EN } from '@/locales/prompts/dev-studio-persona-en'
import { DEV_STUDIO_PERSONA_ZH } from '@/locales/prompts/dev-studio-persona-zh'

export function getDevStudioPersona(locale: Locale): string {
  return locale === 'en' ? DEV_STUDIO_PERSONA_EN : DEV_STUDIO_PERSONA_ZH
}
