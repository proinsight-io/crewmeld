'use client'

import type React from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
import { Boxes, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { TextShimmer } from './text-shimmer'
import { defaultTranslate, type Translate } from './tool-info'

/** Structured trigger descriptor for the BasicTool header row. */
export interface TriggerTitle {
  title: string
  subtitle?: string
  args?: string[]
  action?: ReactNode
}

export interface BasicToolProps {
  /** Optional leading lucide icon component. */
  icon?: ComponentType<{ className?: string }>
  /** Either a structured {@link TriggerTitle} or an arbitrary ReactNode. */
  trigger: TriggerTitle | ReactNode
  children?: ReactNode
  /** Tool execution status — `pending` / `running` trigger shimmer animation. */
  status?: string
  /** When true, renders as a single non-expandable row without chevron. */
  hideDetails?: boolean
  /** Whether the collapsible content is open by default. */
  defaultOpen?: boolean
  'data-testid'?: string
}

/** Returns true when trigger is a structured TriggerTitle object. */
function isTriggerTitle(v: TriggerTitle | ReactNode): v is TriggerTitle {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'title' in (v as object)
}

/**
 * BasicTool — collapsible card used to display a single tool invocation.
 *
 * Behavior summary:
 * - Shimmer animation while `status` is `pending` or `running`.
 * - Expandable section shown only when children are present, `hideDetails`
 *   is false, and status is not pending/running.
 * - Structured {@link TriggerTitle} renders subtitle, arg chips, and an
 *   optional action node when not pending.
 */
export function BasicTool({
  icon: Icon,
  trigger,
  children,
  status,
  hideDetails = false,
  defaultOpen = false,
  'data-testid': testId,
}: BasicToolProps): React.JSX.Element {
  const pending = status === 'pending' || status === 'running'
  const canExpand = Boolean(children) && !hideDetails && !pending

  const [open, setOpen] = useState(defaultOpen && canExpand)

  const triggerTitle = isTriggerTitle(trigger) ? trigger : null

  const staticRow = (
    <div className='flex min-w-0 items-center gap-1.5'>
      {Icon && <Icon className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />}

      <div className='min-w-0 flex-1'>
        {triggerTitle ? (
          <div className='flex min-w-0 items-center gap-1.5'>
            <TextShimmer text={triggerTitle.title} active={pending} />
            {pending && (
              <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
            )}
            {!pending && triggerTitle.subtitle && (
              <span className='truncate text-muted-foreground text-xs'>
                {triggerTitle.subtitle}
              </span>
            )}
            {!pending && triggerTitle.args && triggerTitle.args.length > 0 && (
              <span className='flex items-center gap-1'>
                {triggerTitle.args.map((arg) => (
                  <code
                    key={arg}
                    className='rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground'
                  >
                    {arg}
                  </code>
                ))}
              </span>
            )}
          </div>
        ) : (
          <span className='text-sm'>{trigger as ReactNode}</span>
        )}
      </div>

      {!pending && triggerTitle?.action && (
        <div className='ml-auto shrink-0'>{triggerTitle.action}</div>
      )}
    </div>
  )

  if (hideDetails) {
    return (
      <div data-testid={testId} className='rounded border px-2 py-1.5 text-sm'>
        {staticRow}
      </div>
    )
  }

  if (!canExpand) {
    return (
      <div data-testid={testId} className='rounded border px-2 py-1.5 text-sm'>
        {staticRow}
      </div>
    )
  }

  return (
    <div data-testid={testId} className='rounded border text-sm'>
      <button
        type='button'
        className='flex w-full cursor-pointer items-center px-2 py-1.5 text-left'
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {Icon && <Icon className='mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground' />}

        <div className='min-w-0 flex-1'>
          {triggerTitle ? (
            <div className='flex min-w-0 items-center gap-1.5'>
              <TextShimmer text={triggerTitle.title} active={false} />
              {triggerTitle.subtitle && (
                <span className='truncate text-muted-foreground text-xs'>
                  {triggerTitle.subtitle}
                </span>
              )}
              {triggerTitle.args && triggerTitle.args.length > 0 && (
                <span className='flex items-center gap-1'>
                  {triggerTitle.args.map((arg) => (
                    <code
                      key={arg}
                      className='rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground'
                    >
                      {arg}
                    </code>
                  ))}
                </span>
              )}
            </div>
          ) : (
            <span>{trigger as ReactNode}</span>
          )}
        </div>

        {triggerTitle?.action && <div className='ml-auto shrink-0'>{triggerTitle.action}</div>}

        {open ? (
          <ChevronDown
            data-testid='basic-tool:chevron'
            className='h-3.5 w-3.5 shrink-0 text-muted-foreground'
          />
        ) : (
          <ChevronRight
            data-testid='basic-tool:chevron'
            className='h-3.5 w-3.5 shrink-0 text-muted-foreground'
          />
        )}
      </button>

      {open && (
        <div className='border-t px-2 py-1.5' data-testid='basic-tool:content'>
          {children}
        </div>
      )}
    </div>
  )
}

/** Priority-ordered subtitle field names to scan in GenericTool input. */
const SUBTITLE_FIELDS = [
  'description',
  'query',
  'url',
  'filePath',
  'path',
  'pattern',
  'name',
] as const

/**
 * GenericTool — wraps {@link BasicTool} for unknown / fallback tool types.
 * Shows "Called {tool}", extracts a subtitle from known input fields,
 * and renders up to 3 key=value arg chips for remaining scalar fields.
 */
export function GenericTool({
  tool,
  status,
  hideDetails,
  input,
  t = defaultTranslate,
}: {
  tool: string
  status?: string
  hideDetails?: boolean
  input?: Record<string, unknown>
  t?: Translate
}): React.JSX.Element {
  let subtitle: string | undefined
  const usedKey = new Set<string>()

  if (input) {
    for (const field of SUBTITLE_FIELDS) {
      if (field in input && typeof input[field] === 'string' && input[field]) {
        subtitle = String(input[field])
        usedKey.add(field)
        break
      }
    }
  }

  const args: string[] = []
  if (input) {
    for (const [k, v] of Object.entries(input)) {
      if (usedKey.has(k)) continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        args.push(`${k}=${String(v)}`)
        if (args.length >= 3) break
      }
    }
  }

  return (
    <BasicTool
      icon={Boxes}
      trigger={{ title: t('devStudio.opencode.tool.called', { tool }), subtitle, args }}
      status={status}
      hideDetails={hideDetails}
      data-testid={`generic-tool:${tool}`}
    />
  )
}
