'use client'

import { useEffect, useState } from 'react'
import type { ContactMethod } from '@crewmeld/db/schema'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { contactKey } from '@/lib/human-employees/notify-method'
import { useTranslation } from '@/hooks/use-translation'
import { ContactMethodEditor } from './contact-method-editor'

interface HumanEmployeeFormData {
  name: string
  title: string
  department: string
  contactMethods: ContactMethod[]
}

interface HumanEmployeeFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: HumanEmployeeFormData) => Promise<void>
  initialData?: {
    name: string
    title: string
    department: string | null
    contactMethods: ContactMethod[]
  }
  mode: 'create' | 'edit'
}

export function HumanEmployeeFormDialog({
  open,
  onOpenChange,
  onSubmit,
  initialData,
  mode,
}: HumanEmployeeFormDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [department, setDepartment] = useState('')
  const [contactMethods, setContactMethods] = useState<ContactMethod[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open && initialData) {
      setName(initialData.name)
      setTitle(initialData.title)
      setDepartment(initialData.department ?? '')
      setContactMethods(initialData.contactMethods)
    } else if (open) {
      setName('')
      setTitle('')
      setDepartment('')
      setContactMethods([])
    }
    setError('')
  }, [open, initialData])

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError(t('humanEmployees.formNameRequired'))
      return
    }
    if (!title.trim()) {
      setError(t('humanEmployees.formTitleRequired'))
      return
    }
    // Reject duplicate channels: the same type+value must not appear twice.
    const contactKeys = contactMethods
      .filter((m) => m.value.trim())
      .map((m) => contactKey({ type: m.type, value: m.value.trim() }))
    if (new Set(contactKeys).size !== contactKeys.length) {
      setError(t('humanEmployees.formContactDuplicate'))
      return
    }

    setIsSubmitting(true)
    setError('')
    try {
      await onSubmit({
        name: name.trim(),
        title: title.trim(),
        department: department.trim(),
        contactMethods,
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.operationFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md' data-testid='human-emp-form:dialog'>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('humanEmployees.formTitleCreate')
              : t('humanEmployees.formTitleEdit')}
          </DialogTitle>
        </DialogHeader>

        <div className='space-y-4 py-2'>
          <div className='space-y-2'>
            <Label htmlFor='human-emp-name'>{t('humanEmployees.formNameLabel')}</Label>
            <Input
              id='human-emp-name'
              placeholder={t('humanEmployees.formNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              data-testid='human-emp-form:input:name'
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='human-emp-title'>{t('humanEmployees.formTitleLabel')}</Label>
            <Input
              id='human-emp-title'
              placeholder={t('humanEmployees.formTitlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid='human-emp-form:input:title'
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='human-emp-department'>{t('humanEmployees.formDepartmentLabel')}</Label>
            <Input
              id='human-emp-department'
              placeholder={t('humanEmployees.formDepartmentPlaceholder')}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              data-testid='human-emp-form:input:department'
            />
          </div>

          <div className='space-y-2'>
            <Label>{t('humanEmployees.formContactLabel')}</Label>
            <ContactMethodEditor value={contactMethods} onChange={setContactMethods} />
          </div>

          {error && (
            <p className='text-red-500 text-sm' data-testid='human-emp-form:error'>
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            data-testid='human-emp-form:cancel'
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting}
            data-testid='human-emp-form:submit'
          >
            {isSubmitting ? t('humanEmployees.formSaving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
