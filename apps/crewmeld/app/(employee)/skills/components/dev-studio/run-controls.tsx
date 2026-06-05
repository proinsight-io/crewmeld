'use client'

import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'
import { useTranslation } from '@/hooks/use-translation'

/** Origin used when running in tests/SSR (no window). */
const FALLBACK_ORIGIN = 'http://localhost:6100'

export type CommandVariant = 'bash' | 'workspace-curl' | 'host-curl'

interface RunControlsProps {
  sessionId: string
  manifest: ManifestT
  values: Record<string, unknown>
  formValid: boolean
  running: boolean
  onRun: () => void
  onClear: () => void
  onAdopt: () => void
  /**
   * Whether adoption is available. Defaults to `true`. Set `false` while the
   * session has unapproved package dependencies — the adopt button is then
   * replaced by a hint pointing the operator at the inline review card.
   */
  canAdopt?: boolean
}

/**
 * Action bar below the parameter form: run / clear / copy-cmd / adopt.
 *
 * The copy-cmd dropdown is kind-aware: script tools expose `bash` (run the
 * launch script directly inside the sandbox) while service tools expose
 * `workspace-curl` (start.sh + curl localhost:PORT). Both kinds also offer a
 * `host-curl` variant that calls the BFF run-test route — useful when the
 * operator wants to reproduce the exact request the dialog sends.
 *
 * `Copied` feedback latches for 1.5s so the operator gets confirmation
 * without crowding the bar with an extra toast.
 */
export function RunControls({
  sessionId,
  manifest,
  values,
  formValid,
  running,
  onRun,
  onClear,
  onAdopt,
  canAdopt = true,
}: RunControlsProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  async function onCopy(variant: CommandVariant) {
    const cmd = buildCommand(variant, manifest, values, sessionId)
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail in insecure contexts; silently no-op so the
      // dropdown does not blow up — the operator can still cat the command
      // out of devtools if they really want it.
    }
  }

  return (
    <div className='flex items-center gap-2 border-t pt-3' data-testid='dev-studio:run-controls'>
      <Button
        type='button'
        size='sm'
        onClick={onRun}
        disabled={!formValid || running}
        data-testid='dev-studio:run-controls:run'
      >
        {running ? (
          <Loader2 className='mr-1 size-3 animate-spin' />
        ) : (
          <Play className='mr-1 size-3' />
        )}
        {running ? t('devStudio.test.running') : t('devStudio.test.run')}
      </Button>
      <Button
        type='button'
        size='sm'
        variant='outline'
        onClick={onClear}
        disabled={running}
        data-testid='dev-studio:run-controls:clear'
      >
        {t('devStudio.test.clear')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type='button'
            size='sm'
            variant='outline'
            data-testid='dev-studio:run-controls:copy-trigger'
          >
            {t('devStudio.test.copyCmd')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start'>
          {manifest.kind === 'script' ? (
            <DropdownMenuItem
              onSelect={() => onCopy('bash')}
              data-testid='dev-studio:run-controls:copy:bash'
            >
              {t('devStudio.test.copyCmdBash')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => onCopy('workspace-curl')}
              data-testid='dev-studio:run-controls:copy:workspace-curl'
            >
              {t('devStudio.test.copyCmdWorkspaceCurl')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => onCopy('host-curl')}
            data-testid='dev-studio:run-controls:copy:host-curl'
          >
            {t('devStudio.test.copyCmdHostCurl')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {copied && (
        <span
          className='text-emerald-600 text-xs dark:text-emerald-400'
          data-testid='dev-studio:run-controls:copied'
        >
          {t('devStudio.test.copySuccess')}
        </span>
      )}
      <div className='flex-1' />
      {canAdopt ? (
        <Button
          type='button'
          size='sm'
          onClick={onAdopt}
          data-testid='dev-studio:run-controls:adopt'
        >
          {t('devStudio.adopt.button')}
        </Button>
      ) : (
        <span
          className='text-xs text-muted-foreground'
          data-testid='dev-studio:run-controls:adopt-gated'
        >
          {t('devStudio.adopt.gatedHint')}
        </span>
      )}
    </div>
  )
}

/**
 * Single-quote-wrap a JSON body for safe interpolation into a bash command
 * built with single quotes. Embedded `'` becomes `'\''` (close-quote, escaped
 * literal, reopen-quote) — the standard POSIX trick mirrored from
 * `lib/dev-studio/test-runner.ts`.
 */
function quoteForShell(raw: string): string {
  return raw.replace(/'/g, "'\\''")
}

/**
 * Build the equivalent CLI command for `variant`. Exported for tests so the
 * shell-escaping rules can be exercised without instantiating the component.
 */
export function buildCommand(
  variant: CommandVariant,
  manifest: ManifestT,
  values: Record<string, unknown>,
  sessionId: string
): string {
  const paramsJson = JSON.stringify(values)
  const paramsEscaped = quoteForShell(paramsJson)

  if (variant === 'bash') {
    return `echo '${paramsEscaped}' | bash start.sh`
  }
  if (variant === 'workspace-curl') {
    const { port, path, method } = manifest.service ?? { port: 0, path: '/', method: 'POST' }
    return [
      'bash start.sh &',
      `curl -X ${method} localhost:${port}${path} \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '${paramsEscaped}'`,
    ].join('\n')
  }
  // host-curl
  const origin = typeof window !== 'undefined' ? window.location.origin : FALLBACK_ORIGIN
  const bodyJson = JSON.stringify({ params: values })
  return [
    `curl -X POST ${origin}/api/employee/dev-studio/sessions/${sessionId}/run-test \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '${quoteForShell(bodyJson)}'`,
  ].join('\n')
}
