'use client'

import { useState } from 'react'
import { Lock } from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getIdentityFieldCatalog } from '@/lib/channels/identity-field-catalog'
import type { SopVisibilityRules, VisibilityGroup } from '@/lib/sop/visibility-types'
import { ConditionTree } from './condition-tree'
import { emptyTree } from './tree-ops'

/** A bound channel connection available as a permission tab. */
export interface BoundConnection {
  id: string
  name: string
  type: string
}

interface PermissionPanelProps {
  connections: BoundConnection[]
  value: SopVisibilityRules | null
  onChange: (next: SopVisibilityRules | null) => void
}

function defaultRules(): SopVisibilityRules {
  return { enabled: true, onNoPermission: 'deny', channels: {} }
}

export function PermissionPanel({ connections, value, onChange }: PermissionPanelProps) {
  const rules = value ?? defaultRules()
  const [activeTab, setActiveTab] = useState(connections[0]?.id ?? '')

  const setTree = (connId: string, tree: VisibilityGroup) =>
    onChange({ ...rules, channels: { ...rules.channels, [connId]: tree } })

  return (
    <section className='space-y-4 rounded-lg border p-4'>
      <div className='flex items-center gap-2'>
        <Lock className='h-4 w-4 text-muted-foreground' />
        <h3 className='font-medium text-sm'>访问权限</h3>
      </div>
      <div className='flex items-center gap-3'>
        <Switch
          checked={rules.enabled}
          onCheckedChange={(on) =>
            onChange(on ? { ...rules, enabled: true } : { ...rules, enabled: false })
          }
          data-testid='sop-permission:switch:enabled'
        />
        <Label>启用权限管理(关闭时所有人可见)</Label>
      </div>

      {rules.enabled && (
        <>
          <div className='flex items-center gap-2'>
            <Label>无权限时</Label>
            <Select
              value={rules.onNoPermission}
              onValueChange={(v) => onChange({ ...rules, onNoPermission: v as 'hide' | 'deny' })}
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

          {connections.length === 0 ? (
            <p className='text-muted-foreground text-sm'>该员工未绑定任何渠道,无法配置渠道规则。</p>
          ) : (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                {connections.map((c) => (
                  <TabsTrigger key={c.id} value={c.id} data-testid={`sop-permission:tab:${c.id}`}>
                    {c.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {connections.map((c) => (
                <TabsContent key={c.id} value={c.id}>
                  <ConditionTree
                    connectionId={c.id}
                    catalog={getIdentityFieldCatalog(c.type)}
                    value={rules.channels[c.id] ?? emptyTree()}
                    onChange={(tree) => setTree(c.id, tree)}
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </>
      )}
    </section>
  )
}
