'use client'

import { useEffect, useMemo, useState } from 'react'
import { ConditionTree } from '@/components/sop/permission/condition-tree'
import { emptyTree } from '@/components/sop/permission/tree-ops'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { buildRuleEditorCatalog } from '@/lib/access-rules/rule-editor-catalog'
import { safeRandomUUID } from '@/lib/uuid'
import type { AccessRule, RemoveResult } from '@/hooks/use-access-rules'
import { useTranslation } from '@/hooks/use-translation'

interface UnifiedField {
  key: string
  label: string
}

interface AccessRuleManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rules: AccessRule[]
  onSave: (rule: AccessRule) => Promise<{ ok: boolean }>
  onRemove: (id: string) => Promise<RemoveResult>
}

/**
 * In-place dialog for managing the global named access-rule library: list / new /
 * edit / delete. The rule editor reuses {@link ConditionTree} with a
 * channel-agnostic catalog (free-text plus platform role/user pickers).
 */
export function AccessRuleManagerDialog({
  open,
  onOpenChange,
  rules,
  onSave,
  onRemove,
}: AccessRuleManagerDialogProps) {
  const { t } = useTranslation()
  const [unified, setUnified] = useState<UnifiedField[]>([])
  const [draft, setDraft] = useState<AccessRule | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load the global field map (catalog source) when the dialog opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/employee/channel-field-mappings')
        const json = (await res.json()) as {
          success?: boolean
          data?: { fields?: Array<{ key: string; label?: string }> }
        }
        if (!cancelled && json?.success && Array.isArray(json.data?.fields)) {
          setUnified(json.data.fields.map((f) => ({ key: f.key, label: f.label ?? f.key })))
        }
      } catch {
        // Field map is optional; the editor still offers role/user pickers.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const catalog = useMemo(
    () =>
      buildRuleEditorCatalog(unified, {
        roles: t('accessRules.field.roles'),
        employeeId: t('accessRules.field.employeeId'),
      }),
    [unified, t]
  )

  const startNew = () => {
    setError(null)
    setDraft({ id: safeRandomUUID(), name: '', tree: emptyTree() })
  }

  const startEdit = (rule: AccessRule) => {
    setError(null)
    setDraft({ ...rule, tree: structuredClone(rule.tree) })
  }

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    const res = await onSave(draft)
    if (res.ok) {
      setDraft(null)
      setError(null)
    }
  }

  const remove = async (id: string) => {
    const res = await onRemove(id)
    if (!res.ok) setError(t('accessRules.inUse', { n: res.references.length }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('accessRules.dialogTitle')}</DialogTitle>
        </DialogHeader>

        {error && (
          <p className='text-red-600 text-sm' data-testid='access-rule-manager:error'>
            {error}
          </p>
        )}

        {draft ? (
          <div className='space-y-3'>
            <Input
              data-testid='access-rule-manager:input:name'
              placeholder={t('accessRules.name')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Textarea
              data-testid='access-rule-manager:input:description'
              placeholder={t('accessRules.description')}
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <p className='text-muted-foreground text-xs'>{t('accessRules.liveWarning')}</p>
            <ConditionTree
              connectionId=''
              catalog={catalog}
              value={draft.tree}
              onChange={(tree) => setDraft({ ...draft, tree })}
            />
            <DialogFooter>
              <Button type='button' variant='ghost' onClick={() => setDraft(null)}>
                {t('accessRules.cancel')}
              </Button>
              <Button
                type='button'
                onClick={() => void save()}
                disabled={!draft.name.trim()}
                data-testid='access-rule-manager:submit'
              >
                {t('accessRules.save')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className='space-y-2'>
            {rules.length === 0 ? (
              <p className='text-muted-foreground text-sm'>{t('accessRules.empty')}</p>
            ) : (
              <ul className='space-y-1'>
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className='flex items-center gap-2 rounded border px-3 py-2'
                    data-testid={`access-rule-manager:row:${rule.id}`}
                  >
                    <span className='flex-1 text-sm'>{rule.name}</span>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      onClick={() => startEdit(rule)}
                      data-testid={`access-rule-manager:edit:${rule.id}`}
                    >
                      {t('accessRules.edit')}
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      onClick={() => void remove(rule.id)}
                      data-testid={`access-rule-manager:delete:${rule.id}`}
                    >
                      {t('accessRules.delete')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              type='button'
              size='sm'
              onClick={startNew}
              data-testid='access-rule-manager:new'
            >
              {t('accessRules.newRule')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
