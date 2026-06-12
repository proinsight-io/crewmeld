'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { IdentityFieldDef, VisibilityGroup } from '@/lib/sop/visibility-types'
import { isGroup } from '@/lib/sop/visibility-types'
import { DeptPicker } from './dept-picker'
import {
  addCondition,
  addGroup,
  canAddGroup,
  removeAt,
  toggleOp,
  updateCondition,
} from './tree-ops'
import { UserPicker } from './user-picker'
import { WebRolePicker } from './web-role-picker'
import { WebUserPicker } from './web-user-picker'

interface ConditionTreeProps {
  connectionId: string
  catalog: IdentityFieldDef[]
  value: VisibilityGroup
  onChange: (next: VisibilityGroup) => void
}

/** Split pasted free-text into trimmed, de-duplicated values. */
function splitValues(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,，;；\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
}

export function ConditionTree({ connectionId, catalog, value, onChange }: ConditionTreeProps) {
  const renderGroup = (group: VisibilityGroup, path: number[]) => (
    <div
      className='rounded border p-3 space-y-2'
      data-testid={`sop-permission:group:${path.join('-') || 'root'}`}
    >
      <div className='flex items-center gap-2'>
        <Badge
          role='button'
          onClick={() => onChange(toggleOp(value, path))}
          data-testid={`sop-permission:op-toggle:${path.join('-') || 'root'}`}
        >
          {group.op === 'and' ? '且 (AND)' : '或 (OR)'}
        </Badge>
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={() => onChange(addCondition(value, path))}
          data-testid={`sop-permission:add-condition:${path.join('-') || 'root'}`}
        >
          + 条件
        </Button>
        {canAddGroup(path) && (
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={() => onChange(addGroup(value, path))}
            data-testid={`sop-permission:add-group:${path.join('-') || 'root'}`}
          >
            + 条件组
          </Button>
        )}
        {path.length > 0 && (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => onChange(removeAt(value, path))}
          >
            删除组
          </Button>
        )}
      </div>
      <div className='space-y-2 pl-3'>
        {group.children.map((child, i) => {
          const childPath = [...path, i]
          if (isGroup(child)) return <div key={i}>{renderGroup(child, childPath)}</div>
          const field = catalog.find((f) => f.key === child.field) ?? catalog[0]
          return (
            <div
              key={i}
              className='flex flex-wrap items-start gap-2'
              data-testid={`sop-permission:condition:${childPath.join('-')}`}
            >
              <Select
                value={child.field}
                onValueChange={(v) => onChange(updateCondition(value, childPath, { field: v }))}
              >
                <SelectTrigger className='w-32'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={child.operator}
                onValueChange={(v) =>
                  onChange(
                    updateCondition(value, childPath, { operator: v as 'equals' | 'contains' })
                  )
                }
              >
                <SelectTrigger className='w-24'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='equals'>等于</SelectItem>
                  <SelectItem value='contains'>包含</SelectItem>
                </SelectContent>
              </Select>
              {field?.valueSource === 'dept-picker' && (
                <DeptPicker
                  connectionId={connectionId}
                  value={child.values}
                  onChange={(ids) => onChange(updateCondition(value, childPath, { values: ids }))}
                />
              )}
              {field?.valueSource === 'user-picker' && (
                <UserPicker
                  connectionId={connectionId}
                  value={child.values}
                  onChange={(ids) => onChange(updateCondition(value, childPath, { values: ids }))}
                />
              )}
              {field?.valueSource === 'web-user-picker' && (
                <WebUserPicker
                  value={child.values}
                  onChange={(ids) => onChange(updateCondition(value, childPath, { values: ids }))}
                />
              )}
              {field?.valueSource === 'web-role-picker' && (
                <WebRolePicker
                  value={child.values}
                  onChange={(ids) => onChange(updateCondition(value, childPath, { values: ids }))}
                />
              )}
              {field?.valueSource === 'free-text' && (
                <Textarea
                  className='w-64'
                  placeholder='多个值用逗号/换行分隔'
                  defaultValue={child.values.join('\n')}
                  onBlur={(e) =>
                    onChange(
                      updateCondition(value, childPath, { values: splitValues(e.target.value) })
                    )
                  }
                  data-testid={`sop-permission:values:${childPath.join('-')}`}
                />
              )}
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => onChange(removeAt(value, childPath))}
              >
                删除
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )

  return renderGroup(value, [])
}
