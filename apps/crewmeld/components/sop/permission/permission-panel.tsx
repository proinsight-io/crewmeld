'use client'

import { Lock } from 'lucide-react'
import { ConditionField } from '@/components/identity/condition-field'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { IdentityFieldDef, SopVisibilityRules } from '@/lib/sop/visibility-types'
import { emptyTree } from './tree-ops'

interface PermissionPanelProps {
  /** Current visibility rules (null = not yet configured → uses defaultRules). */
  rules: SopVisibilityRules | null
  /** Emits the next rules on every edit. */
  onChange: (next: SopVisibilityRules | null) => void
  /**
   * Channel-agnostic identity-field catalog, built by the parent page from the
   * unified field map ({@link buildRuleEditorCatalog}). Forwarded to the
   * single {@link ConditionField} so the editor offers the correct field options.
   */
  catalog: IdentityFieldDef[]
}

/** Returns a sane initial value for newly-enabled permission rules. */
function defaultRules(): SopVisibilityRules {
  return { enabled: true, onNoPermission: 'deny', tree: emptyTree() }
}

/**
 * SOP visibility-rule editor.
 *
 * Renders an enable toggle, an on-no-permission selector, and a single
 * channel-agnostic {@link ConditionField} that writes to
 * {@link SopVisibilityRules.tree}. The per-channel Tabs UI has been removed;
 * the condition tree is evaluated against the caller's resolved identity
 * regardless of which channel the request arrived on.
 *
 * The `catalog` is fetched by the parent page (from the unified field map) so
 * this component remains pure/controlled with no network dependency of its own.
 */
export function PermissionPanel({ rules, onChange, catalog }: PermissionPanelProps) {
  const effective = rules ?? defaultRules()

  return (
    <section className='space-y-4 rounded-lg border p-4' aria-label='访问权限'>
      <div className='flex items-center gap-2'>
        <Lock className='h-4 w-4 text-muted-foreground' />
        <h3 className='font-medium text-sm'>访问权限</h3>
      </div>

      <div className='flex items-center gap-3'>
        <Switch
          checked={effective.enabled}
          onCheckedChange={(on) =>
            onChange(on ? { ...effective, enabled: true } : { ...effective, enabled: false })
          }
          data-testid='sop-permission:switch:enabled'
        />
        <Label>启用权限管理(关闭时所有人可见)</Label>
      </div>

      {effective.enabled && (
        <>
          <div className='flex items-center gap-2'>
            <Label>无权限时</Label>
            <Select
              value={effective.onNoPermission ?? 'hide'}
              onValueChange={(v) =>
                onChange({ ...effective, onNoPermission: v as 'hide' | 'deny' })
              }
            >
              <SelectTrigger className='w-44' data-testid='sop-permission:select:no-permission'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='hide'>隐藏(对 AI 不可见)</SelectItem>
                <SelectItem value='deny'>提示无权限</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div data-testid='sop-permission:condition-editor'>
            <ConditionField
              value={effective.tree ?? emptyTree()}
              onChange={(tree) => onChange({ ...effective, tree })}
              catalog={catalog}
              connectionId=''
            />
          </div>
        </>
      )}
    </section>
  )
}
