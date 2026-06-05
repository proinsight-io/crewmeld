'use client'

import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/use-translation'

/**
 * Placeholder component for P1-deferred features.
 *
 * Shown on menus that route to feature pages not yet implemented in P0.
 */
export function ComingSoon({ feature }: { feature: string }) {
  const { t } = useTranslation()
  return (
    <div className='flex min-h-[60vh] items-center justify-center'>
      <Card className='p-8 text-center'>
        <h2 className='mb-2 font-semibold text-xl'>{feature}</h2>
        <p className='text-muted-foreground'>{t('common.comingInP1')}</p>
      </Card>
    </div>
  )
}
