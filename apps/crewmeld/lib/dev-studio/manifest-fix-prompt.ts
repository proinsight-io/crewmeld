/**
 * Builds the hidden prompt sent to the AI when `manifest.json` fails to parse.
 *
 * Extracted as a pure function so it can be unit-tested independently of the
 * React component tree. The caller is responsible for acquiring the `t` function
 * from `useTranslation` and for dispatching the resulting string to the AI.
 *
 * @param detail - Raw Zod / JSON parse error text from the manifest endpoint.
 * @param t - Locale translation function (accepts key + interpolation vars).
 * @returns Localised prompt string ready to send as a hidden chat message.
 */
export function buildManifestFixPrompt(
  detail: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return t('devStudio.test.manifestAutoFix', { detail })
}
