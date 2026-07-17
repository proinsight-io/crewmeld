'use client'

import { Button } from '@/components/ui/button'

/** Represents an opencode permission.asked event requiring user approval. */
export interface OpencodePermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

/**
 * Inline approval card for an opencode `permission.asked` event.
 *
 * Renders the requested permission name and patterns, then offers three
 * action buttons: Deny (reject), Allow Once (once), Allow Always (always).
 */
export function OpencodePermissionCard({
  permission,
  onReply,
}: {
  permission: OpencodePermission
  onReply: (reply: 'once' | 'always' | 'reject') => void
}): JSX.Element {
  return (
    <div
      data-testid='opencode-permission:card'
      className='rounded-md border border-amber-300 bg-amber-50 p-3 text-sm'
    >
      <div className='mb-2 font-medium'>需要授权：{permission.permission}</div>
      {permission.patterns.length > 0 && (
        <pre className='mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs'>
          {permission.patterns.join('\n')}
        </pre>
      )}
      <div className='flex gap-2'>
        <Button
          type='button'
          size='sm'
          variant='destructive'
          data-testid='opencode-permission:reject'
          onClick={() => onReply('reject')}
        >
          拒绝
        </Button>
        <Button
          type='button'
          size='sm'
          variant='outline'
          data-testid='opencode-permission:allow-once'
          onClick={() => onReply('once')}
        >
          允许一次
        </Button>
        <Button
          type='button'
          size='sm'
          data-testid='opencode-permission:allow-always'
          onClick={() => onReply('always')}
        >
          始终允许
        </Button>
      </div>
    </div>
  )
}
