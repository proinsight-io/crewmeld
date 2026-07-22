import type { ComponentType } from 'react'
import { DEFAULT_LOCALE, messages } from '@/locales'
import {
  Boxes,
  Brain,
  FileCode,
  Glasses,
  Globe,
  List,
  ListChecks,
  ListTree,
  MessageCircleQuestion,
  Search,
  Terminal,
} from 'lucide-react'

/** Returns the basename of a file path. */
export function getFilename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Returns the directory portion of a file path. */
export function getDirectory(path: string): string {
  const parts = path.split(/[\\/]/)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

export interface ToolInfo {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle?: string
}

/** Locale-aware translate function, matching the shape returned by useTranslation. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

/**
 * A translate fn bound to the default locale, for the rare non-React caller that
 * cannot reach the {@link useTranslation} hook (e.g. a renderer invoked directly
 * as a plain function). Production render paths always inject the live,
 * locale-aware `t` via `ToolPartDisplay`; this is only the fallback.
 */
export const defaultTranslate: Translate = (key, vars) => {
  const root = messages[DEFAULT_LOCALE] as unknown as Record<string, unknown>
  const raw = key
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
      root
    )
  let text = typeof raw === 'string' ? raw : key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

/**
 * Returns display metadata (icon, title, subtitle) for a given opencode tool name.
 * Titles are localized via `t`; dynamic subtitles (file names, patterns) are
 * passed through verbatim.
 *
 * @param tool - The tool identifier string.
 * @param input - The raw input payload passed to the tool call.
 * @param metadata - Optional metadata attached to the tool state.
 * @param t - Locale-aware translate function.
 */
export function getToolInfo(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  t: Translate
): ToolInfo {
  const lc = tool.toLowerCase()

  switch (lc) {
    case 'read':
      return {
        icon: Glasses,
        title: t('devStudio.opencode.tool.read'),
        subtitle: input?.filePath ? getFilename(String(input.filePath)) : undefined,
      }

    case 'list':
      return {
        icon: List,
        title: t('devStudio.opencode.tool.list'),
        subtitle: input?.path ? getFilename(String(input.path)) : undefined,
      }

    case 'glob':
      return {
        icon: Search,
        title: 'Glob',
        subtitle: input?.pattern ? String(input.pattern) : undefined,
      }

    case 'grep':
      return {
        icon: Search,
        title: 'Grep',
        subtitle: input?.pattern ? String(input.pattern) : undefined,
      }

    case 'webfetch':
      return {
        icon: Globe,
        title: t('devStudio.opencode.tool.webfetch'),
        subtitle: input?.url ? String(input.url) : undefined,
      }

    case 'websearch':
      return {
        icon: Globe,
        title: t('devStudio.opencode.tool.websearch'),
        subtitle: input?.query ? String(input.query) : undefined,
      }

    case 'task':
      return {
        icon: ListTree,
        title: t('devStudio.opencode.tool.task'),
        subtitle: input?.description ? String(input.description) : undefined,
      }

    case 'bash':
      return {
        icon: Terminal,
        title: t('devStudio.opencode.tool.bash'),
        subtitle: input?.description ? String(input.description) : undefined,
      }

    case 'edit':
      return {
        icon: FileCode,
        title: t('devStudio.opencode.tool.edit'),
        subtitle: input?.filePath ? getFilename(String(input.filePath)) : undefined,
      }

    case 'write':
      return {
        icon: FileCode,
        title: t('devStudio.opencode.tool.write'),
        subtitle: input?.filePath ? getFilename(String(input.filePath)) : undefined,
      }

    case 'apply_patch': {
      const fileCount = metadata?.fileCount !== undefined ? Number(metadata.fileCount) : undefined
      return {
        icon: FileCode,
        title: t('devStudio.opencode.tool.patch'),
        subtitle:
          fileCount !== undefined
            ? t('devStudio.opencode.tool.fileCount', { count: fileCount })
            : undefined,
      }
    }

    case 'todowrite':
      return {
        icon: ListChecks,
        title: t('devStudio.opencode.tool.todo'),
      }

    case 'question':
      return {
        icon: MessageCircleQuestion,
        title: t('devStudio.opencode.tool.question'),
      }

    case 'skill': {
      const skillName = input?.name !== undefined ? String(input.name) : undefined
      return {
        icon: Brain,
        title: skillName ?? t('devStudio.opencode.tool.skill'),
      }
    }

    default:
      return {
        icon: Boxes,
        title: tool,
      }
  }
}
