'use client'

import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Post-save banner prompting an operator to redeploy a running tool instance
 * after its env vars / system connection changed.
 *
 * Only meaningful for long-lived deployments (`opensandbox` service / `k8s`),
 * which snapshot the resolved env at deploy time — a save alone does not reach
 * the running container. Script-type tools (`opensandbox-script`) resolve env
 * fresh on every invocation, so the caller never mounts this for them.
 */
export function RedeployPrompt({
  instanceName,
  redeploying,
  onLater,
  onRedeploy,
}: {
  instanceName: string
  redeploying: boolean
  onLater: () => void
  onRedeploy: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className='fixed right-4 bottom-4 z-50 w-[360px] rounded-lg border border-yellow-300 bg-yellow-50 p-4 shadow-lg'
      data-testid='skills:redeploy-prompt'
    >
      <div className='flex items-start gap-2'>
        <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-yellow-600' />
        <div className='min-w-0 flex-1'>
          <p className='font-medium text-sm text-yellow-800'>{t('skills.redeployTitle')}</p>
          <p className='mt-1 text-xs text-yellow-700'>
            {t('skills.redeployBody', { name: instanceName })}
          </p>
          <div className='mt-3 flex justify-end gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={onLater}
              disabled={redeploying}
              data-testid='skills:redeploy-prompt:later'
            >
              {t('skills.redeployLater')}
            </Button>
            <Button
              size='sm'
              className='bg-yellow-600 hover:bg-yellow-700'
              onClick={onRedeploy}
              disabled={redeploying}
              data-testid='skills:redeploy-prompt:now'
            >
              {t('skills.redeployNow')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
