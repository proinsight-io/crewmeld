'use client'

import { useState } from 'react'
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { AvatarPickerDialog } from '@/app/(employee)/employees/new/components/avatar-picker-dialog'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/use-translation'

const NAME_MAX_LENGTH = 50
const DESCRIPTION_MAX_LENGTH = 200

interface EmployeeHeaderProps {
  employee: {
    id: string
    name: string
    avatar: string | null
    description: string | null
    status: string
    activatedAt: string | null
    createdAt: string
  }
  onDelete: () => Promise<void>
  onUpdate?: () => Promise<void> | void
}

function getDaysActive(activatedAt: string | null): number {
  if (!activatedAt) return 0
  const diff = Date.now() - new Date(activatedAt).getTime()
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
}

export function EmployeeHeader({ employee, onDelete, onUpdate }: EmployeeHeaderProps) {
  const router = useRouter()
  const { t, tMessage } = useTranslation()
  const [isUpdating, setIsUpdating] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [editName, setEditName] = useState(employee.name)
  const [editDescription, setEditDescription] = useState(employee.description ?? '')
  const [editAvatar, setEditAvatar] = useState(employee.avatar ?? '')
  const [editError, setEditError] = useState<string | null>(null)
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)

  const daysActive = getDaysActive(employee.activatedAt)

  const handleDelete = async () => {
    if (isUpdating) return
    setIsUpdating(true)
    setDeleteError(null)
    try {
      await onDelete()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('employees.deleteFailed'))
    } finally {
      setIsUpdating(false)
    }
  }

  const handleStartEdit = () => {
    setEditName(employee.name)
    setEditDescription(employee.description ?? '')
    setEditAvatar(employee.avatar ?? '')
    setEditError(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    if (isSaving) return
    setIsEditing(false)
    setEditError(null)
  }

  const handleSave = async () => {
    if (isSaving) return
    const trimmedName = editName.trim()
    const trimmedDescription = editDescription.trim()

    if (trimmedName.length === 0) {
      setEditError(t('employees.headerNameRequired'))
      return
    }
    if (trimmedName.length > NAME_MAX_LENGTH) {
      setEditError(t('employees.headerNameTooLong'))
      return
    }
    if (trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
      setEditError(t('employees.headerDescriptionTooLong'))
      return
    }

    setIsSaving(true)
    setEditError(null)
    try {
      const body: Record<string, unknown> = {
        name: trimmedName,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
      }
      if (editAvatar && editAvatar !== (employee.avatar ?? '')) {
        body.avatar = editAvatar
      }
      const res = await fetch(`/api/employee/employees/${employee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(tMessage(json) || t('employees.headerUpdateFailed'))
      }
      await onUpdate?.()
      setIsEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t('employees.headerUpdateFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className='border-gray-200 border-b bg-white px-6 py-5'>
      <div className='flex items-start gap-4'>
        <Button
          variant='ghost'
          size='icon'
          onClick={() => router.push('/employees')}
          className='shrink-0'
        >
          <ArrowLeft className='h-5 w-5' />
        </Button>

        {isEditing ? (
          <button
            type='button'
            onClick={() => setShowAvatarPicker(true)}
            disabled={isSaving}
            className='group relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-600 text-lg transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50'
            aria-label={t('employees.avatarPickerTitle')}
          >
            {editAvatar || employee.name.charAt(0)}
            <span className='-bottom-0.5 -right-0.5 absolute flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm group-hover:text-gray-700'>
              <Pencil className='h-3 w-3' />
            </span>
          </button>
        ) : (
          <div className='flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-600 text-lg'>
            {employee.avatar ?? employee.name.charAt(0)}
          </div>
        )}

        <div className='min-w-0 flex-1'>
          {isEditing ? (
            <div className='space-y-2'>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t('employees.headerNamePlaceholder')}
                maxLength={NAME_MAX_LENGTH}
                disabled={isSaving}
                className='font-semibold text-xl'
              />
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t('employees.headerDescriptionPlaceholder')}
                maxLength={DESCRIPTION_MAX_LENGTH}
                disabled={isSaving}
                rows={2}
                className='text-sm'
              />
              {editError && <p className='text-red-600 text-sm'>{editError}</p>}
              <div className='flex items-center gap-2'>
                <Button onClick={handleSave} disabled={isSaving} size='sm'>
                  {isSaving ? t('employees.headerSaving') : t('employees.headerSaveBtn')}
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                >
                  {t('employees.headerCancel')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <h1 className='truncate font-semibold text-gray-900 text-xl'>{employee.name}</h1>
              {employee.activatedAt && (
                <div className='mt-1 text-gray-500 text-sm'>
                  <span>{t('employees.onDuty', { days: daysActive })}</span>
                </div>
              )}
              {employee.description && (
                <p className='mt-0.5 line-clamp-2 text-gray-500 text-sm'>{employee.description}</p>
              )}
            </>
          )}
        </div>

        {!isEditing && (
          <div className='flex shrink-0 items-center gap-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleStartEdit}
              disabled={isUpdating}
              className='text-gray-500 hover:bg-gray-50 hover:text-gray-700'
            >
              <Pencil className='h-4 w-4' />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setDeleteError(null)
                setShowDeleteDialog(true)
              }}
              disabled={isUpdating}
              className='text-red-500 hover:bg-red-50 hover:text-red-700'
            >
              <Trash2 className='h-4 w-4' />
            </Button>
          </div>
        )}
      </div>

      <AvatarPickerDialog
        open={showAvatarPicker}
        onOpenChange={setShowAvatarPicker}
        value={editAvatar || (employee.avatar ?? '')}
        onSelect={(emoji) => setEditAvatar(emoji)}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('employees.headerDeleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('employees.deleteDetailWarning', { name: employee.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className='px-1 text-red-600 text-sm'>{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUpdating}>
              {t('employees.headerCancel')}
            </AlertDialogCancel>
            {!deleteError && (
              <Button
                onClick={handleDelete}
                className='bg-red-600 hover:bg-red-700'
                disabled={isUpdating}
              >
                {t('employees.headerDeleteBtn')}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
