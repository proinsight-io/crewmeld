'use client'

import type { Edge, Node } from 'reactflow'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { type Locale, messages } from '@/locales'
import { useLocaleStore } from '@/stores/locale/store'
import type { SopExit, SopNode, SopSerializedEdge } from '@/types/sop'

/** ReactFlow node data for the SOP editor canvas */
export interface SopNodeData {
  sopNode: SopNode
  onDelete?: (nodeId: string) => void
}

/** ReactFlow edge data (empty for now — edges encode routing via SopExit) */
export type SopEdgeData = {}

interface SopEditorState {
  /** SOP definition ID (null for new) */
  sopId: string | null
  name: string
  description: string
  triggerType: 'manual' | 'scheduled' | 'event'
  triggerConfig: Record<string, unknown>
  sopTimeoutMinutes: number
  maxRejectionCycles: number
  version: number

  /** ReactFlow canvas state */
  nodes: Node<SopNodeData>[]
  edges: Edge<SopEdgeData>[]
  selectedNodeId: string | null

  /** L1 node test-run result cache — nodeId -> output variables */
  nodeTestResults: Record<string, Record<string, unknown>>

  /** Dirty flag */
  isDirty: boolean
  isSaving: boolean
}

interface SopEditorActions {
  /** Reset store to initial state (for new SOP or when navigating away) */
  reset: () => void

  /** Load SOP definition from API data */
  loadDefinition: (data: {
    id: string
    name: string
    description: string | null
    triggerType: string
    triggerConfig: Record<string, unknown>
    sopTimeoutMinutes: number | null
    maxRejectionCycles: number | null
    version: number
    nodes: SopNode[]
    edges: SopSerializedEdge[]
  }) => void

  /** Update metadata fields */
  setName: (name: string) => void
  setDescription: (description: string) => void
  setTriggerType: (triggerType: 'manual' | 'scheduled' | 'event') => void
  setTriggerConfig: (triggerConfig: Record<string, unknown>) => void
  setSopTimeoutMinutes: (minutes: number) => void
  setMaxRejectionCycles: (cycles: number) => void

  /** Canvas operations */
  setNodes: (nodes: Node<SopNodeData>[]) => void
  setEdges: (edges: Edge<SopEdgeData>[]) => void
  setSelectedNodeId: (nodeId: string | null) => void

  /** Update a single SOP node's data */
  updateSopNode: (nodeId: string, updates: Partial<SopNode>) => void

  /** Add a new node at given position */
  addNode: (type: SopNode['type'], position: { x: number; y: number }) => void

  /** Remove a node and its connected edges */
  removeNode: (nodeId: string) => void

  /** L1 node test-run result cache */
  setNodeTestResult: (nodeId: string, output: Record<string, unknown>) => void
  clearNodeTestResults: () => void

  /** Save state */
  setIsSaving: (saving: boolean) => void
  markClean: () => void
  /** Mark the editor dirty without changing a tracked field (e.g. SOP-level settings). */
  markDirty: () => void
}

const INITIAL_STATE: SopEditorState = {
  sopId: null,
  name: '',
  description: '',
  triggerType: 'manual',
  triggerConfig: {},
  sopTimeoutMinutes: 1440,
  maxRejectionCycles: 3,
  version: 1,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  nodeTestResults: {},
  isDirty: false,
  isSaving: false,
}

let nextNodeCounter = 1

function getNodeLabels(): Record<SopNode['type'], string> {
  const locale = useLocaleStore.getState().locale as Locale
  const t = messages[locale].sops
  return {
    digital_employee: t.nodeTypeEmployee,
    human_employee: t.nodeTypeHuman,
    human_confirm: t.nodeTypeHumanConfirm,
    switch: t.nodeTypeBranch,
  }
}

/** SOP node type -> ReactFlow nodeType mapping */
const NODE_TYPE_MAP: Record<string, string> = {
  digital_employee: 'sopDigitalEmployee',
  human_employee: 'sopHumanEmployee',
  human_confirm: 'sopHumanConfirm',
  switch: 'sopSwitch',
}

function mapNodeType(sopType: string): string {
  return NODE_TYPE_MAP[sopType] ?? 'sopDigitalEmployee'
}

export const useSopEditorStore = create<SopEditorState & SopEditorActions>()(
  devtools(
    (set, get) => ({
      ...INITIAL_STATE,

      reset: () => {
        nextNodeCounter = 1
        set(INITIAL_STATE)
      },

      loadDefinition: (data) => {
        const nodes: Node<SopNodeData>[] = data.nodes.map((sopNode) => ({
          id: sopNode.id,
          type: mapNodeType(sopNode.type),
          position: sopNode.position,
          data: { sopNode },
        }))

        const edges: Edge<SopEdgeData>[] = data.edges.map((e) => ({
          id: e.id,
          type: 'sop-edge',
          source: e.source,
          sourceHandle: e.sourceHandle ?? undefined,
          target: e.target,
          targetHandle: e.targetHandle ?? undefined,
          data: {},
        }))

        // Extract max ID number from existing nodes to avoid ID conflicts
        let maxId = 0
        for (const n of data.nodes) {
          const match = n.id.match(/^sop-node-(\d+)$/)
          if (match) maxId = Math.max(maxId, Number(match[1]))
        }
        nextNodeCounter = maxId + 1

        set({
          sopId: data.id,
          name: data.name,
          description: data.description ?? '',
          triggerType: data.triggerType as 'manual' | 'scheduled' | 'event',
          triggerConfig: data.triggerConfig,
          sopTimeoutMinutes: data.sopTimeoutMinutes ?? 1440,
          maxRejectionCycles: data.maxRejectionCycles ?? 3,
          version: data.version,
          nodes,
          edges,
          selectedNodeId: null,
          isDirty: false,
          isSaving: false,
        })
      },

      setName: (name) => set({ name, isDirty: true }),
      setDescription: (description) => set({ description, isDirty: true }),
      setTriggerType: (triggerType) => set({ triggerType, isDirty: true }),
      setTriggerConfig: (triggerConfig) => set({ triggerConfig, isDirty: true }),
      setSopTimeoutMinutes: (sopTimeoutMinutes) => set({ sopTimeoutMinutes, isDirty: true }),
      setMaxRejectionCycles: (maxRejectionCycles) => set({ maxRejectionCycles, isDirty: true }),

      setNodes: (nodes) => set({ nodes, isDirty: true }),
      setEdges: (edges) => set({ edges, isDirty: true }),
      setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),

      updateSopNode: (nodeId, updates) => {
        const { nodes } = get()
        const updated = nodes.map((n) => {
          if (n.id !== nodeId) return n
          return {
            ...n,
            data: {
              ...n.data,
              sopNode: { ...n.data.sopNode, ...updates },
            },
          }
        })
        set({ nodes: updated, isDirty: true })
      },

      addNode: (type, position) => {
        const id = `sop-node-${nextNodeCounter++}`

        // Error exit — automatically included for all node types
        const errorExit: SopExit = {
          id: `${id}-exit-error`,
          label: 'error',
          targetNodeId: null,
          type: 'error',
        }

        let defaultExits: SopExit[]

        switch (type) {
          case 'human_confirm':
            defaultExits = [
              {
                id: `${id}-exit-approved`,
                label: 'approved',
                targetNodeId: null,
                condition: { type: 'approval_result', operator: 'eq', value: 'approved' },
              },
              {
                id: `${id}-exit-rejected`,
                label: 'rejected',
                targetNodeId: null,
                condition: { type: 'approval_result', operator: 'eq', value: 'rejected' },
              },
              {
                id: `${id}-exit-timeout`,
                label: 'timeout',
                targetNodeId: null,
                condition: { type: 'always' },
              },
              errorExit,
            ]
            break
          case 'switch':
            defaultExits = [
              {
                id: `${id}-exit-case-1`,
                label: 'Branch 1',
                targetNodeId: null,
                condition: { type: 'variable', operator: 'eq', value: '' },
              },
              {
                id: `${id}-exit-default`,
                label: 'default',
                targetNodeId: null,
                condition: { type: 'always' },
              },
              errorExit,
            ]
            break
          default:
            defaultExits = [
              {
                id: `${id}-exit-default`,
                label: messages[useLocaleStore.getState().locale as Locale].sops.defaultName,
                targetNodeId: null,
                condition: { type: 'always' },
              },
              errorExit,
            ]
        }

        const sopNode: SopNode = {
          id,
          name: `${getNodeLabels()[type]} ${nextNodeCounter - 1}`,
          type,
          exits: defaultExits,
          position,
          timeoutMinutes: type === 'human_confirm' ? 60 : undefined,
          conditionConfig: type === 'switch' ? {} : undefined,
        }

        const newNode: Node<SopNodeData> = {
          id,
          type: mapNodeType(type),
          position,
          data: { sopNode },
        }

        set((state) => ({
          nodes: [...state.nodes, newNode],
          isDirty: true,
          selectedNodeId: id,
        }))
      },

      removeNode: (nodeId) => {
        set((state) => ({
          nodes: state.nodes.filter((n) => n.id !== nodeId),
          edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
          isDirty: true,
        }))
      },

      setNodeTestResult: (nodeId, output) => {
        set((state) => ({
          nodeTestResults: { ...state.nodeTestResults, [nodeId]: output },
        }))
      },
      clearNodeTestResults: () => set({ nodeTestResults: {} }),

      setIsSaving: (isSaving) => set({ isSaving }),
      markClean: () => set({ isDirty: false }),
      markDirty: () => set({ isDirty: true }),
    }),
    { name: 'sop-editor-store' }
  )
)
