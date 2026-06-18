'use client'

import { useState } from 'react'
import { AccessRuleManagerDialog } from '@/components/identity/access-rule-manager-dialog'
import { ConditionTree } from '@/components/sop/permission/condition-tree'
import { emptyTree } from '@/components/sop/permission/tree-ops'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getRuleRefId, makeRuleRefTree } from '@/lib/access-rules/condition-mode'
import { safeRandomUUID } from '@/lib/uuid'
import type { ConditionTree as ConditionTreeType } from '@/lib/identity/condition-tree'
import type { IdentityFieldDef } from '@/lib/sop/visibility-types'
import { useAccessRules } from '@/hooks/use-access-rules'
import { useTranslation } from '@/hooks/use-translation'

/** Sentinel select value for the custom-inline mode. */
const CUSTOM = '__custom__'

interface ConditionFieldProps {
  /** The condition tree for this slot (single source of truth). */
  value: ConditionTreeType
  onChange: (next: ConditionTreeType) => void
  /** Inline (custom-mode) editor catalog — channel-specific at the call site. */
  catalog: IdentityFieldDef[]
  /** Inline (custom-mode) channel pickers; '' when there is no channel context. */
  connectionId: string
}

/**
 * Identity-condition slot: dropdown-first selection of a named condition group,
 * with a custom inline tree as the fallback. Named mode stores the tree as a
 * single `{ ruleRef }`; custom mode reuses {@link ConditionTree}. A
 * {@link AccessRuleManagerDialog} edits the global library in place.
 */
export function ConditionField({ value, onChange, catalog, connectionId }: ConditionFieldProps) {
  const { t } = useTranslation()
  const { rules, refresh, saveRule, removeRule } = useAccessRules()
  const [managerOpen, setManagerOpen] = useState(false)

  const refId = getRuleRefId(value)
  const named = refId !== null
  const referenced = refId !== null ? rules.find((r) => r.id === refId) : undefined

  const onSelect = (next: string) => {
    onChange(next === CUSTOM ? emptyTree() : makeRuleRefTree(next))
  }

  const saveAs = async () => {
    const name = window.prompt(t('accessRules.saveAsPrompt'))
    if (!name) return
    const id = safeRandomUUID()
    const res = await saveRule({ id, name, tree: value })
    if (res.ok) onChange(makeRuleRefTree(id))
  }

  const unbind = () => {
    if (referenced) onChange(structuredClone(referenced.tree))
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <Select value={named ? (refId as string) : CUSTOM} onValueChange={onSelect}>
          <SelectTrigger className='w-56' data-testid='condition-field:select'>
            <SelectValue placeholder={t('accessRules.selectPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {rules.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>{t('accessRules.custom')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={() => setManagerOpen(true)}
          data-testid='condition-field:manage'
        >
          {t('accessRules.manage')}
        </Button>
      </div>

      {named ? (
        <div
          className='flex items-center gap-2 rounded border bg-muted/30 px-3 py-2 text-sm'
          data-testid='condition-field:named-summary'
        >
          <span className='flex-1'>
            {referenced
              ? t('accessRules.namedSummary', { name: referenced.name })
              : t('accessRules.unknownRule')}
          </span>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={unbind}
            disabled={!referenced}
            data-testid='condition-field:unbind'
          >
            {t('accessRules.unbind')}
          </Button>
        </div>
      ) : (
        <div className='space-y-2'>
          <ConditionTree
            connectionId={connectionId}
            catalog={catalog}
            value={value}
            onChange={onChange}
          />
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={() => void saveAs()}
            data-testid='condition-field:save-as'
          >
            {t('accessRules.saveAs')}
          </Button>
        </div>
      )}

      <AccessRuleManagerDialog
        open={managerOpen}
        onOpenChange={(o) => {
          setManagerOpen(o)
          if (!o) void refresh()
        }}
        rules={rules}
        onSave={saveRule}
        onRemove={removeRule}
      />
    </div>
  )
}
