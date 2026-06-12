import { checkSecurity, type SecurityCheckResult } from '@/app/(employee)/skills/security-check'

const IMPORT_RE = /\bimport\s+[^;]*?from\s+['"]/
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/
const REQUIRE_RE = /\brequire\s*\(/

/**
 * Static check for an API-tool pre/post snippet. Reuses the shared JS security
 * rules but additionally forbids module imports (the sandbox provides no module
 * system) and surfaces import/require as hard errors rather than confirmations.
 */
export function checkApiToolCode(code: string): SecurityCheckResult {
  const base = checkSecurity(code, [], 'javascript')
  const errors = [...base.errors]

  if (IMPORT_RE.test(code) || DYNAMIC_IMPORT_RE.test(code)) {
    errors.push('API tool code cannot use import (sandbox has no module system)')
  }
  if (REQUIRE_RE.test(code)) {
    errors.push('API tool code cannot use require (sandbox has no module system)')
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings: base.warnings,
    // import confirmations are now errors; drop them from confirmations
    confirmations: base.confirmations.filter((c) => !/dependenc/i.test(c)),
  }
}

/** Supported locales for {@link localizeApiToolError}. */
type CheckLocale = 'zh-CN' | 'en'

/**
 * Bilingual messages for the api-tool static-check errors that can surface to the
 * editor. The check functions intentionally return English (kept stable for unit
 * tests and shared script-tool callers); this map localizes them at the editor
 * surface only.
 */
const API_TOOL_ERROR_I18N: Record<string, Record<CheckLocale, string>> = {
  'Code missing return statement, tool must return a result': {
    'zh-CN': '代码缺少 return 语句，工具必须返回结果',
    en: 'Code missing return statement, tool must return a result',
  },
  'API tool code cannot use import (sandbox has no module system)': {
    'zh-CN': 'API 工具代码不能使用 import（沙箱无模块系统）',
    en: 'API tool code cannot use import (sandbox has no module system)',
  },
  'API tool code cannot use require (sandbox has no module system)': {
    'zh-CN': 'API 工具代码不能使用 require（沙箱无模块系统）',
    en: 'API tool code cannot use require (sandbox has no module system)',
  },
  'Access to process object forbidden (except process.env)': {
    'zh-CN': '禁止访问 process 对象（process.env 除外）',
    en: 'Access to process object forbidden (except process.env)',
  },
}

/**
 * Localize one api-tool static-check error message for display in the editor.
 * Unknown messages (e.g. the dynamic code-size error) fall back to a localized
 * prefix match, then to the original English string.
 *
 * @param msg - The English error message from {@link checkApiToolCode}.
 * @param locale - Target locale.
 */
export function localizeApiToolError(msg: string, locale: CheckLocale): string {
  const mapped = API_TOOL_ERROR_I18N[msg]
  if (mapped) return mapped[locale]
  if (msg.startsWith('Code size exceeds limit')) {
    return locale === 'zh-CN' ? '代码体积超出限制（上限 100KB）' : msg
  }
  return msg
}
