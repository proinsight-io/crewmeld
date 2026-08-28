'use client'

import { useState } from 'react'
import { FrequentQuestionTable } from '@/components/knowledge/frequent-question-table'
import { RagflowDatasetList } from '@/components/knowledge/ragflow-dataset-list'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/use-translation'

export default function KnowledgeListPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'knowledge' | 'frequent'>('knowledge')
  return (
    <div>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='font-semibold text-2xl text-gray-900'>{t('knowledge.title')}</h1>
        <div className='flex gap-2'>
          <Button
            variant={tab === 'knowledge' ? 'default' : 'outline'}
            onClick={() => setTab('knowledge')}
          >
            知识库列表
          </Button>
          <Button
            variant={tab === 'frequent' ? 'default' : 'outline'}
            onClick={() => setTab('frequent')}
            data-testid='knowledge:tab:frequent'
          >
            用户高频问题
          </Button>
        </div>
      </div>
      {tab === 'knowledge' ? <RagflowDatasetList /> : <FrequentQuestionTable />}
    </div>
  )
}
