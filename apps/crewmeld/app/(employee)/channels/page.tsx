'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, Radio, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CHANNEL_TYPE_LIST, CONNECTION_TYPE_I18N_KEYS } from '@/lib/connectors/types'
import { useTranslation } from '@/hooks/use-translation'
import { PermissionGuard } from '../components/permission-guard'
import { AddChannelWizard } from './components/add-channel-wizard'
import { ChannelCard } from './components/channel-card'
import { EditChannelDialog } from './components/edit-channel-dialog'
import { FieldMappingEditor } from './components/field-mapping-editor'
import { type ChannelRecord, useChannels } from './hooks/use-channels'

export default function ChannelsPage() {
  const { t } = useTranslation()

  const STATUS_OPTIONS = [
    { value: 'all', label: t('common.allStatus') },
    { value: 'connected', label: t('channels.statusConnected') },
    { value: 'disconnected', label: t('channels.statusDisconnected') },
    { value: 'error', label: t('channels.statusError') },
  ]
  const [filterType, setFilterType] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [editingChannel, setEditingChannel] = useState<ChannelRecord | null>(null)

  const { channels, pagination, isLoading, remove, test, handleSearch, handlePageChange, refresh } =
    useChannels({ type: filterType, status: filterStatus })

  // Notification bot state (stores the currently selected channelId per channel type)
  const [notificationBotIds, setNotificationBotIds] = useState<Record<string, string>>({})

  // Load notification bot settings for each channel type
  useEffect(() => {
    const types = ['feishu', 'wecom', 'dingtalk', 'email', 'telegram']
    for (const t of types) {
      fetch(`/api/employee/channels/notification-bot?type=${t}`)
        .then((r) => r.json())
        .then((body) => {
          if (body.success && body.data?.channelId) {
            setNotificationBotIds((prev) => ({ ...prev, [t]: body.data.channelId }))
          }
        })
        .catch(() => {})
    }
  }, [])

  const handleSetNotificationBot = useCallback(
    async (channelId: string) => {
      const channel = channels.find((c) => c.id === channelId)
      if (!channel) return
      const res = await fetch('/api/employee/channels/notification-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType: channel.type, channelId }),
      })
      const json = await res.json()
      if (json.success) {
        setNotificationBotIds((prev) => ({ ...prev, [channel.type]: channelId }))
      }
    },
    [channels]
  )

  return (
    <div>
      {/* Page header */}
      <div className='mb-6 flex items-center justify-between'>
        <div>
          <h1 className='font-bold text-2xl text-gray-900'>{t('channels.title')}</h1>
          <p className='mt-1 text-gray-500 text-sm'>{t('channels.subtitle')}</p>
        </div>
        <PermissionGuard requires='channel:create'>
          <Button onClick={() => setWizardOpen(true)} data-testid='channel-list:create'>
            <Plus className='mr-2 h-4 w-4' />
            {t('channels.addChannel')}
          </Button>
        </PermissionGuard>
      </div>

      {/* Filters */}
      <div className='mb-6 flex items-center gap-3'>
        <div className='relative max-w-sm flex-1'>
          <Search className='-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-gray-400' />
          <Input
            data-testid='channel-list:search'
            placeholder={t('channels.searchPlaceholder')}
            className='pl-9'
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-700 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
          data-testid='channel-list:filter:type'
        >
          <option value='all'>{t('common.allTypes')}</option>
          {CHANNEL_TYPE_LIST.map((type) => (
            <option key={type} value={type}>
              {t(CONNECTION_TYPE_I18N_KEYS[type])}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-700 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
          data-testid='channel-list:filter:status'
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div data-testid='channel-list:container'>
        {/* Loading */}
        {isLoading && (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className='h-48 animate-pulse rounded-xl border border-gray-200 bg-gray-100'
              />
            ))}
          </div>
        )}

        {/* Empty */}
        {!isLoading && channels.length === 0 && (
          <div className='flex h-64 flex-col items-center justify-center rounded-xl border-2 border-gray-300 border-dashed'>
            <Radio className='h-10 w-10 text-gray-300' />
            <p className='mt-3 mb-2 font-medium text-gray-500 text-sm'>
              {t('channels.noChannels')}
            </p>
            <p className='mb-4 text-gray-400 text-xs'>{t('channels.noChannelsHint')}</p>
            <PermissionGuard requires='channel:create'>
              <Button variant='outline' size='sm' onClick={() => setWizardOpen(true)}>
                <Plus className='h-4 w-4' />
                {t('channels.addFirstChannel')}
              </Button>
            </PermissionGuard>
          </div>
        )}

        {/* Channel grid */}
        {!isLoading && channels.length > 0 && (
          <>
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {channels.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  isNotificationBot={notificationBotIds[channel.type] === channel.id}
                  onEdit={setEditingChannel}
                  onDelete={remove}
                  onTest={test}
                  onSetNotificationBot={handleSetNotificationBot}
                />
              ))}
            </div>

            {pagination.totalPages > 1 && (
              <div className='mt-6 flex items-center justify-between'>
                <p className='text-gray-500 text-sm'>
                  {t('channels.paginationTotal', {
                    total: pagination.total,
                    page: pagination.page,
                    totalPages: pagination.totalPages,
                  })}
                </p>
                <div className='flex gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={pagination.page <= 1}
                    onClick={() => handlePageChange(pagination.page - 1)}
                  >
                    {t('channels.prevPage')}
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => handlePageChange(pagination.page + 1)}
                  >
                    {t('channels.nextPage')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Global field mapping matrix */}
      <PermissionGuard requires='channel:list'>
        <div className='mt-8 rounded-lg border p-4'>
          <FieldMappingEditor />
        </div>
      </PermissionGuard>

      {/* Add wizard */}
      <AddChannelWizard open={wizardOpen} onOpenChange={setWizardOpen} onCreated={refresh} />

      {/* Edit dialog */}
      <EditChannelDialog
        channel={editingChannel}
        onOpenChange={(open) => {
          if (!open) setEditingChannel(null)
        }}
        onUpdated={refresh}
      />
    </div>
  )
}
