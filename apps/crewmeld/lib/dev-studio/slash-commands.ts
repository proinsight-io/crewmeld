export type DevStudioLocale = 'zh-CN' | 'en'

export interface SlashCommand {
  /** Sent to claude-cli verbatim (no `/` prefix in this field). */
  englishName: string
  /** Displayed to user in UI based on active locale. */
  localizedNames: Record<DevStudioLocale, string>
  /** Short one-line explanation displayed below the name. */
  descriptions: Record<DevStudioLocale, string>
}

export const SUPERPOWERS_COMMANDS: SlashCommand[] = [
  {
    englishName: 'brainstorming',
    localizedNames: { 'zh-CN': '头脑风暴', en: 'Brainstorm' },
    descriptions: {
      'zh-CN': '把想法变成具体设计 — 从模糊需求开始',
      en: 'Turn ideas into a concrete design',
    },
  },
  {
    englishName: 'writing-plans',
    localizedNames: { 'zh-CN': '写实施计划', en: 'Write plan' },
    descriptions: {
      'zh-CN': '把设计转成可执行的多步计划',
      en: 'Turn a design into an executable plan',
    },
  },
  {
    englishName: 'test-driven-development',
    localizedNames: { 'zh-CN': 'TDD 开发', en: 'TDD' },
    descriptions: {
      'zh-CN': '测试驱动开发：先写失败测试再实现',
      en: 'Write failing test first, then implement',
    },
  },
  {
    englishName: 'subagent-driven-development',
    localizedNames: { 'zh-CN': '子代理并行开发', en: 'Parallel subagents' },
    descriptions: {
      'zh-CN': '派发独立任务给多个并行 agent',
      en: 'Dispatch independent tasks to parallel agents',
    },
  },
  {
    englishName: 'systematic-debugging',
    localizedNames: { 'zh-CN': '系统化调试', en: 'Systematic debug' },
    descriptions: {
      'zh-CN': '用科学方法定位 bug，先验证假设再改代码',
      en: 'Scientific bug investigation',
    },
  },
  {
    englishName: 'requesting-code-review',
    localizedNames: { 'zh-CN': '请求代码审查', en: 'Request review' },
    descriptions: {
      'zh-CN': '提交代码后请求严格审查',
      en: 'Request rigorous code review',
    },
  },
  {
    englishName: 'verification-before-completion',
    localizedNames: { 'zh-CN': '完成前验证', en: 'Verify before done' },
    descriptions: {
      'zh-CN': '声称完成前必须跑命令、确认输出',
      en: 'Run commands and confirm output before claiming done',
    },
  },
  {
    englishName: 'finishing-a-development-branch',
    localizedNames: { 'zh-CN': '收尾开发分支', en: 'Finish branch' },
    descriptions: {
      'zh-CN': '决定如何 merge/PR/清理',
      en: 'Decide how to merge/PR/cleanup',
    },
  },
]

/**
 * Filters commands by query against English name OR localized name (case-insensitive).
 * Empty query returns all commands. The `/` prefix is not part of the query.
 */
export function filterCommands(query: string, locale: DevStudioLocale): SlashCommand[] {
  if (!query) return SUPERPOWERS_COMMANDS
  const q = query.toLowerCase()
  return SUPERPOWERS_COMMANDS.filter((c) => {
    if (c.englishName.toLowerCase().includes(q)) return true
    const localized = c.localizedNames[locale]
    if (localized.includes(query)) return true // case-sensitive zh
    if (localized.toLowerCase().includes(q)) return true
    return false
  })
}
