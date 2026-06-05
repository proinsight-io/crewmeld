'use client'

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/use-translation'
import { formatRelativeTimeI18n } from '@/lib/core/utils/formatting'
import type { ManifestT } from '@/lib/dev-studio/manifest-reader'

interface ToolMetaSummaryProps {
  manifest: ManifestT
}

/**
 * Read-only banner shown at the top of the test tab summarising the tool
 * the operator is about to invoke.
 *
 * Layout: name + version badge on the left, "Updated X ago" on the right
 * (label and relative-time bucket both follow the operator's UI locale);
 * second row for description when present. Editing happens via the
 * existing {@link EditMetaDialog} surfaced by `ToolMetaBar` in the
 * header — this component is intentionally non-interactive.
 */
export function ToolMetaSummary({ manifest }: ToolMetaSummaryProps) {
  const { t, locale } = useTranslation()
  return (
    <div className='space-y-1 rounded border p-3' data-testid='dev-studio:tool-meta-summary'>
      <div className='flex items-center gap-2'>
        <span className='font-medium text-sm'>{manifest.name}</span>
        <Badge variant='outline' className='text-xs'>
          v{manifest.version}
        </Badge>
        <span className='ml-auto text-muted-foreground text-xs'>
          {t('devStudio.header.updatedAt', {
            when: formatRelativeTimeI18n(manifest.updatedAt, locale),
          })}
        </span>
      </div>
      {manifest.description && (
        <p className='text-muted-foreground text-sm'>{manifest.description}</p>
      )}
    </div>
  )
}
