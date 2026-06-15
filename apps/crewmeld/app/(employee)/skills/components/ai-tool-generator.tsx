'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Download,
  Loader2,
  Paperclip,
  Play,
  PlugZap,
  Send,
  Sparkles,
  User,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectionType, DatabaseSubtype } from '@/lib/connectors/types'
import {
  CONNECTION_TYPE_I18N_KEYS,
  CONNECTION_TYPE_ICONS,
  DATABASE_SUBTYPE_ICONS,
  DATABASE_SUBTYPE_LABELS,
} from '@/lib/connectors/types'
import { BrowserStorage, STORAGE_KEYS } from '@/lib/core/utils/browser-storage'
import { cn } from '@/lib/core/utils/cn'
import { useTranslation } from '@/hooks/use-translation'
import { checkSecurity } from '../security-check'
import type { GitHubProjectContext } from '../types'
import { configKeyToEnvName, skillEnvName } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelConfig {
  id: string
  providerId: string
  displayName: string
  modelName: string | null
  isActive: boolean
}

interface SelectedConnection {
  id: string
  name: string
  type: string
  typeLabel: string
  /** Database subtype (only when type === 'database') */
  dbType?: string
  /** Connection config field info (for LLM prompt, names only, no values) */
  envVars: Array<{ envName: string; label: string }>
  /** Connection config actual values (for injecting env during test) */
  envValues: Record<string, string>
}

interface GeneratedTool {
  title: string
  description: string
  parameters: {
    type: string
    properties: Record<
      string,
      { type: string; description: string; secret?: boolean; envName?: string }
    >
    required?: string[]
  }
  code: string
  language?: 'javascript' | 'python'
  testParams?: Record<string, string>
  fixExplanation?: string
  /** System connection injected env vars (merged into instance envVars on save) */
  connectionEnvVars?: Array<{ name: string; value: string }>
  /** API doc (Markdown), describes non-secret input params and return values for SOP LLM */
  apiDoc?: string
  /** System connection type required by the tool */
  connectorType?: { type: string; dbType?: string }
  /**
   * File handling mode flag from the LLM-generated JSON. When true, the
   * tool uses the SOP workspace mount (/workspace/inputs + /workspace/outputs)
   * and bypasses the warm pool. Defaults to false when the field is
   * omitted (= legacy boto3 + presigned-URL mode).
   */
  needsFileMount?: boolean
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  thinkingCollapsed?: boolean
  tool?: GeneratedTool
  securityResult?: { passed: boolean; errors: string[]; warnings: string[] }
  testResult?: { success: boolean; result?: unknown; error?: string }
  files?: { name: string; type: string }[]
  isStreaming?: boolean
  /** Pipeline phase badge for this message */
  phaseBadge?: string
  /** File download info (when tool returns files, supports base64 and MinIO download link) */
  fileDownload?: { fileName: string; format: string; base64?: string; downloadUrl?: string }
  /** Hidden message (not shown in chat UI, only sent as context to AI) */
  hidden?: boolean
}

type PipelinePhase =
  | 'idle'
  | 'generating'
  | 'security-check'
  | 'need-confirm'
  | 'confirmed'
  | 'file-fix'
  | 'testing'
  | 'validating'
  | 'fixing'
  | 'done'
  | 'need-input'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build Chinese LLM output field name fallback map from i18n.
 * Some Chinese LLMs return JSON with localized keys; we build these from
 * translations so the parsing logic stays bilingual without Unicode escapes.
 */
function buildZhLlmFields(t: (key: string) => string) {
  return {
    fileName: t('skills.zhLlmFieldFileName'),
    format: t('skills.zhLlmFieldFormat'),
    downloadUrl: t('skills.zhLlmFieldDownloadUrl'),
    fileContent: t('skills.zhLlmFieldFileContent'),
  } as const
}

/**
 * Get Chinese confirmation words from i18n, used to detect user approval in
 * the confirmation phase. Returns a regex-ready pipe-separated string.
 */
function getZhConfirmWords(t: (key: string) => string): string {
  return t('skills.zhConfirmWords')
}

/** Ensure value is string, objects auto-serialized to JSON */
function safeStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  return JSON.stringify(v, null, 2)
}

/** Clean literal escape chars in text: \n -> newline, \t -> tab, \" -> " */
function cleanEscapes(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"')
}

/**
 * Format execution result as readable string
 * - Convert \n \t in strings to real newlines/tabs
 * - Restore \" in strings to "
 * - If value is valid JSON string, auto-parse and indent
 */
function formatResultStr(result: unknown): string {
  if (result === null || result === undefined) return 'null'
  if (typeof result === 'string') return result

  // Recursive: if string looks like JSON, try parsing first
  function cleanValue(val: unknown): unknown {
    if (typeof val === 'string') {
      // Try parsing nested JSON string
      const trimmed = val.trim()
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          return cleanValue(JSON.parse(trimmed))
        } catch {
          /* not JSON, keep as string */
        }
      }
      return val
    }
    if (Array.isArray(val)) return val.map(cleanValue)
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val)) {
        out[k] = cleanValue(v)
      }
      return out
    }
    return val
  }

  const cleaned = cleanValue(result)
  return JSON.stringify(cleaned, null, 2) ?? 'null'
}

function extractToolFromContent(content: string): GeneratedTool | null {
  const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[1])
    if (parsed.title && parsed.code) return parsed as GeneratedTool
  } catch {
    // ignore
  }
  return null
}

/** Match all thinking tag variants: think, thinking */
const THINK_OPEN = '<(?:think(?:ing)?)>'
const THINK_CLOSE = '<\\/(?:think(?:ing)?)>'
const THINK_TAG = '<\\/?(?:think(?:ing)?)>'

function extractThinking(content: string): { thinking: string; reply: string } {
  // Extract all closed thinking blocks
  const thinkRegex = new RegExp(`${THINK_OPEN}([\\s\\S]*?)${THINK_CLOSE}`, 'g')
  const thinkParts: string[] = []
  let match: RegExpExecArray | null
  while ((match = thinkRegex.exec(content)) !== null) {
    if (match[1].trim()) thinkParts.push(match[1].trim())
  }
  // Remove all closed thinking blocks
  let reply = content.replace(new RegExp(`${THINK_OPEN}[\\s\\S]*?${THINK_CLOSE}`, 'g'), '')
  // Remove unclosed open tags (streaming may have only open tags)
  reply = reply.replace(new RegExp(`${THINK_OPEN}[\\s\\S]*$`, 'g'), '')
  // Clean up remaining orphan close tags
  reply = reply.replace(new RegExp(THINK_CLOSE, 'g'), '')
  reply = reply.trim()
  return { thinking: thinkParts.join('\n\n'), reply }
}

/** Remove thinking tags themselves, keep text content inside */
function stripThinkTags(content: string): string {
  return content.replace(new RegExp(THINK_TAG, 'g'), '').trim()
}

/** Basic result validation: check if return value is obviously invalid */
function validateResultBasic(
  result: unknown,
  t: (key: string, params?: Record<string, string | number>) => string
): string | null {
  if (result === null || result === undefined) {
    return t('skills.generatorReturnNull')
  }
  if (typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>
    // Tool self-reported failure (success:false). Surface error/message/error_message
    // so we don't waste a round on LLM semantic validation for an obvious failure.
    if (obj.success === false) {
      const detail =
        (obj.error as unknown) ||
        (obj.message as unknown) ||
        (obj.error_message as unknown) ||
        (obj.errorMessage as unknown) ||
        ''
      return t('skills.generatorReturnError', {
        error: String(detail).trim() || t('skills.generatorReturnSuccessFalse'),
      })
    }
    // Object with only error field -> API call failed
    if (obj.error && Object.keys(obj).length <= 2) {
      return t('skills.generatorReturnError', { error: String(obj.error) })
    }
    // Empty object
    if (Object.keys(obj).length === 0) {
      return t('skills.generatorReturnEmptyObj')
    }
  }
  if (Array.isArray(result) && result.length === 0) {
    return t('skills.generatorReturnEmptyArr')
  }
  return null
}

// DB driver imports we recognize as "this tool talks to a database".
// Triggers a connection-required guard before running in the sandbox Pod, where
// `localhost:3306` would otherwise resolve to the Pod itself, not the user's DB.
const DB_DRIVER_PATTERNS: RegExp[] = [
  /\b(?:from|import)\s+['"]mysql2?(?:\/[^'"]*)?['"]/,
  /\b(?:from|import)\s+['"]pg(?:\/[^'"]*)?['"]/,
  /\b(?:from|import)\s+['"]mongodb(?:\/[^'"]*)?['"]/,
  /\b(?:from|import)\s+['"]mssql(?:\/[^'"]*)?['"]/,
  /\b(?:from|import)\s+['"]oracledb(?:\/[^'"]*)?['"]/,
  /\b(?:from|import)\s+['"]ioredis(?:\/[^'"]*)?['"]/,
  /\brequire\s*\(\s*['"]mysql2?(?:\/[^'"]*)?['"]\s*\)/,
  /\brequire\s*\(\s*['"]pg(?:\/[^'"]*)?['"]\s*\)/,
  /\brequire\s*\(\s*['"]mongodb(?:\/[^'"]*)?['"]\s*\)/,
  /\brequire\s*\(\s*['"]mssql(?:\/[^'"]*)?['"]\s*\)/,
  /\brequire\s*\(\s*['"]oracledb(?:\/[^'"]*)?['"]\s*\)/,
  /\brequire\s*\(\s*['"]ioredis(?:\/[^'"]*)?['"]\s*\)/,
  // Python
  /^\s*(?:from|import)\s+(?:pymysql|psycopg2|psycopg|pymongo|sqlalchemy|cx_Oracle|oracledb|redis)\b/m,
  /^\s*(?:from|import)\s+mysql\.connector\b/m,
]

/** True when the tool code talks to a database (requires a real Connection at test time). */
function isDatabaseTool(
  code: string,
  paramProperties: Record<string, { type?: string }> | undefined
): boolean {
  if (DB_DRIVER_PATTERNS.some((re) => re.test(code))) return true
  // Fallback heuristic: parameters look like a DB connection. `host + port` alone
  // is too broad (matches HTTP/SSH/SMTP/Kafka/etc.), so require a DB-specific key.
  const keys = new Set(Object.keys(paramProperties ?? {}).map((k) => k.toLowerCase()))
  if (keys.has('host') && (keys.has('database') || keys.has('dbname'))) {
    return true
  }
  return false
}

/** Detect if result is file type (supports MinIO download link and base64) */
function detectFileResult(
  result: unknown,
  zhFields: ReturnType<typeof buildZhLlmFields>
): { fileName: string; format: string; base64?: string; downloadUrl?: string } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const obj = result as Record<string, unknown>
  // Supports both localized and English key names for LLM output parsing
  const fileName = (obj[zhFields.fileName] ?? obj.fileName ?? obj.filename) as string | undefined
  const format = (obj[zhFields.format] ?? obj.format ?? obj.type) as string | undefined
  const fmt = String(format ?? fileName?.split('.').pop() ?? 'bin')

  // Prefer MinIO download link detection
  const downloadUrl = (obj[zhFields.downloadUrl] ?? obj.downloadUrl ?? obj.download_url) as
    | string
    | undefined
  if (
    fileName &&
    downloadUrl &&
    typeof downloadUrl === 'string' &&
    downloadUrl.startsWith('http')
  ) {
    return { fileName: String(fileName), format: fmt, downloadUrl }
  }

  // Compatible with legacy base64 method
  const base64 = (obj[zhFields.fileContent] ?? obj.fileContent ?? obj.content ?? obj.base64) as
    | string
    | undefined
  if (fileName && base64 && typeof base64 === 'string' && base64.length > 100) {
    return { fileName: String(fileName), format: fmt, base64 }
  }
  return null
}

/** Generate downloadable blob URL from base64 and format */
function createDownloadUrl(base64: string, format: string): string {
  const mimeMap: Record<string, string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    pdf: 'application/pdf',
    zip: 'application/zip',
    json: 'application/json',
    txt: 'text/plain',
  }
  const mime = mimeMap[format.toLowerCase()] ?? 'application/octet-stream'
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AiToolGenerator({
  open,
  onClose,
  onCreated,
  apiKeys,
  preloadedModels,
  preloadedConnections,
  importProjectContext,
}: {
  open: boolean
  onClose: () => void
  onCreated?: (tool: GeneratedTool) => void
  apiKeys?: { name: string; value: string }[]
  preloadedModels?: ModelConfig[]
  preloadedConnections?: Array<{
    id: string
    name: string
    type: string
    config: Record<string, unknown>
  }>
  /** Import context (GitHub zip or Markdown/TXT), auto-sent as first message when dialog opens */
  importProjectContext?: GitHubProjectContext | null
}) {
  const { t, locale } = useTranslation()
  const zhLlmFields = useMemo(() => buildZhLlmFields(t), [t])
  const zhConfirmWordsStr = useMemo(() => getZhConfirmWords(t), [t])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<PipelinePhase>('idle')
  const [currentTool, setCurrentTool] = useState<GeneratedTool | null>(null)
  // Trial run params (init from testParams, user-editable)
  const [trialParams, setTrialParams] = useState<Record<string, string>>({})
  const [fixCount, setFixCount] = useState(0)
  const [regenCount, setRegenCount] = useState(0)
  // Refs mirror fixCount/regenCount so MAX_FIX/MAX_REGEN guards read the latest
  // value inside the recursive runPipeline → sendFixRequest chain (avoid stale closures).
  const fixCountRef = useRef(0)
  const regenCountRef = useRef(0)
  const bumpFixCount = useCallback(() => {
    fixCountRef.current += 1
    setFixCount(fixCountRef.current)
  }, [])
  const resetFixCount = useCallback(() => {
    fixCountRef.current = 0
    setFixCount(0)
  }, [])
  const bumpRegenCount = useCallback(() => {
    regenCountRef.current += 1
    setRegenCount(regenCountRef.current)
  }, [])
  const resetRegenCount = useCallback(() => {
    regenCountRef.current = 0
    setRegenCount(0)
  }, [])
  // Security confirmation: pending pipeline context awaiting user confirmation
  const pendingConfirmRef = useRef<{
    tool: GeneratedTool
    chatHistory: ChatMessage[]
    type?: 'security' | 'file-verify' | 'db-conn'
  } | null>(null)
  const fileFixFeedbackRef = useRef<string | null>(null)
  // Track security items confirmed by user in this session to avoid re-asking
  const confirmedItemsRef = useRef<Set<string>>(new Set())
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  /** Whether user manually scrolled up (true = do not force scroll to bottom) */
  const userScrolledUpRef = useRef(false)
  /** True during programmatic auto-scroll, prevents onScroll from misreading user intent */
  const autoScrollingRef = useRef(false)
  /** Show "scroll to bottom" button */
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  /** Input height (drag to resize) */
  const [inputHeight, setInputHeight] = useState(120)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  // System connections
  const [availableConnections, setAvailableConnections] = useState<SelectedConnection[]>([])
  const availableConnectionsRef = useRef(availableConnections)
  const [selectedConnIds, _setSelectedConnIds] = useState<Set<string>>(new Set())
  const selectedConnIdsRef = useRef(selectedConnIds)
  const setSelectedConnIds = useCallback(
    (val: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      _setSelectedConnIds((prev) => {
        const next = typeof val === 'function' ? val(prev) : val
        selectedConnIdsRef.current = next
        return next
      })
    },
    []
  )
  const [connDropdownOpen, setConnDropdownOpen] = useState(false)
  const connDropdownRef = useRef<HTMLDivElement>(null)
  // Cascading dropdown: level1=connection type, level2=database subtype (database only)
  const [connLevel, setConnLevel] = useState<'type' | 'dbType' | 'pick'>('type')
  const [connSelectedType, setConnSelectedType] = useState<string | null>(null)
  const [connSelectedDbType, setConnSelectedDbType] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const msgIdRef = useRef(0)
  const importContextSentRef = useRef(false)

  const MAX_FIX = 10
  const MAX_REGEN = 3

  // Select initial model: prefer localStorage record, fallback to first
  const pickInitialModel = useCallback((list: ModelConfig[]) => {
    if (list.length === 0) return
    const saved = BrowserStorage.getItem<string>(STORAGE_KEYS.LAST_SELECTED_MODEL, '')
    const match = saved && list.some((m) => m.id === saved)
    const picked = match ? saved : list[0].id
    setSelectedModelId(picked)
    BrowserStorage.setItem(STORAGE_KEYS.LAST_SELECTED_MODEL, picked)
  }, [])

  // Load models: prefer preloaded data, fallback to fetch
  useEffect(() => {
    if (!open) return
    if (preloadedModels && preloadedModels.length > 0 && models.length === 0) {
      setModels(preloadedModels)
      if (!selectedModelId) {
        pickInitialModel(preloadedModels)
      }
      return
    }
    if (models.length > 0) return
    fetch('/api/employee/models?activeOnly=true')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data?.configs) {
          const active = data.data.configs as ModelConfig[]
          setModels(active)
          if (active.length > 0 && !selectedModelId) {
            pickInitialModel(active)
          }
        }
      })
      .catch(() => {})
  }, [open, preloadedModels, pickInitialModel])

  // Init from preloaded connection data (no longer fetch inside dialog)
  useEffect(() => {
    if (!open) return
    if (availableConnections.length > 0) return
    if (!preloadedConnections || preloadedConnections.length === 0) return

    const conns = preloadedConnections.map((c) => {
      const typeLabel = CONNECTION_TYPE_I18N_KEYS[c.type as ConnectionType]
        ? t(CONNECTION_TYPE_I18N_KEYS[c.type as ConnectionType])
        : c.type
      const envVars: Array<{ envName: string; label: string }> = []
      for (const [key, val] of Object.entries(c.config)) {
        if (val !== undefined && val !== null && String(val).trim()) {
          const envName = `CONN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
          envVars.push({ envName, label: key })
        }
      }
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        typeLabel,
        dbType: c.type === 'database' ? (c.config.dbType as string | undefined) : undefined,
        envVars,
        envValues: {}, // lazy-loaded real values
      } satisfies SelectedConnection
    })
    setAvailableConnections(conns)
    availableConnectionsRef.current = conns
  }, [open, preloadedConnections])

  // When generated tool has connectorType, auto-select matching connection
  useEffect(() => {
    if (!currentTool?.connectorType || availableConnections.length === 0) return
    const ct = currentTool.connectorType
    const matching = availableConnections.filter((c) => {
      if (c.type !== ct.type) return false
      if (ct.dbType && c.dbType !== ct.dbType) return false
      return true
    })
    if (matching.length > 0) {
      setSelectedConnIds(new Set([matching[0].id]))
    }
  }, [currentTool?.connectorType, availableConnections])

  // When selected connection changes, fetch unmasked config values
  useEffect(() => {
    if (selectedConnIds.size === 0) return
    const ids = Array.from(selectedConnIds)
    // Only fetch connections without loaded envValues
    const needLoad = ids.filter((id) => {
      const conn = availableConnections.find((c) => c.id === id)
      return conn && Object.keys(conn.envValues).length === 0
    })
    if (needLoad.length === 0) return

    fetch(`/api/employee/connectors/config?ids=${needLoad.join(',')}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.configs) {
          const configMap = new Map<string, Record<string, unknown>>()
          for (const cfg of data.configs as Array<{
            id: string
            config: Record<string, unknown>
          }>) {
            configMap.set(cfg.id, cfg.config)
          }
          setAvailableConnections((prev) =>
            prev.map((c) => {
              const rawConfig = configMap.get(c.id)
              if (!rawConfig) return c
              const envValues: Record<string, string> = {}
              for (const [key, val] of Object.entries(rawConfig)) {
                if (val !== undefined && val !== null && String(val).trim()) {
                  const envName = `CONN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
                  envValues[envName] = String(val)
                }
              }
              return { ...c, envValues }
            })
          )
        }
      })
      .catch(() => {})
  }, [selectedConnIds])

  // Auto scroll - only when user is near bottom
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      autoScrollingRef.current = true
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      // Smooth animation ~300ms, onScroll does not update userScrolledUpRef during
      setTimeout(() => {
        autoScrollingRef.current = false
      }, 350)
    }
  }, [messages])

  // Listen to chat area scroll, detect if user manually scrolled up
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    // Do not update user intent during programmatic scroll, only update button display
    const threshold = 60
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    if (!autoScrollingRef.current) {
      userScrolledUpRef.current = !atBottom
    }
    setShowScrollBtn(!atBottom)
  }, [])

  // When user scrolls up via wheel, immediately mark as manually scrolled up
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      userScrolledUpRef.current = true
      setShowScrollBtn(true)
    }
  }, [])

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    userScrolledUpRef.current = false
    setShowScrollBtn(false)
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  /** Reset all session state (shared by close & open) */
  const resetSessionState = useCallback(() => {
    setMessages([])
    setInput('')
    setPhase('idle')
    setCurrentTool(null)
    setTrialParams({})
    resetFixCount()
    resetRegenCount()
    setShowScrollBtn(false)
    setInputHeight(120)
    setModelDropdownOpen(false)
    setConnDropdownOpen(false)
    setConnLevel('type')
    setConnSelectedType(null)
    setConnSelectedDbType(null)
    setShowCloseConfirm(false)
    // ref cleanup
    confirmedItemsRef.current.clear()
    pendingConfirmRef.current = null
    fileFixFeedbackRef.current = null
    userScrolledUpRef.current = false
    autoScrollingRef.current = false
    dragRef.current = null
    abortRef.current = null
    msgIdRef.current = 0
    importContextSentRef.current = false
  }, [])

  // Fallback: force reset each time open goes false -> true, prevent stale state
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      resetSessionState()
    }
    prevOpenRef.current = open
  }, [open, resetSessionState])

  const handleClose = useCallback(() => {
    abortRef.current?.abort()
    resetSessionState()
    setSelectedConnIds(new Set())
    onClose()
  }, [onClose, resetSessionState])

  /** Request close: show confirmation if chat history exists, otherwise close */
  const requestClose = useCallback(() => {
    if (messages.some((m) => m.role === 'user')) {
      setShowCloseConfirm(true)
    } else {
      handleClose()
    }
  }, [messages, handleClose])

  // Close on ESC / close dropdown
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCloseConfirm) {
          setShowCloseConfirm(false)
        } else if (modelDropdownOpen) {
          setModelDropdownOpen(false)
        } else {
          requestClose()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, modelDropdownOpen, showCloseConfirm, requestClose])

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [modelDropdownOpen])

  // Close connection dropdown on outside click
  useEffect(() => {
    if (!connDropdownOpen) return
    const onClick = (e: MouseEvent) => {
      if (connDropdownRef.current && !connDropdownRef.current.contains(e.target as Node)) {
        setConnDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [connDropdownOpen])

  // Drag to resize input height
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.min(500, Math.max(48, dragRef.current.startH + delta))
      setInputHeight(newH)
    }
    const onMouseUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Sync trial params when currentTool changes
  useEffect(() => {
    if (currentTool?.testParams) {
      setTrialParams({ ...currentTool.testParams })
    } else {
      setTrialParams({})
    }
  }, [currentTool])

  // Auto-focus input when user input needed
  useEffect(() => {
    if (
      phase === 'need-input' ||
      phase === 'need-confirm' ||
      phase === 'done' ||
      phase === 'idle'
    ) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [phase])

  const nextId = useCallback(() => ++msgIdRef.current, [])


  // -------------------------------------------------------------------------
  // Toggle thinking collapse
  // -------------------------------------------------------------------------

  const toggleThinking = useCallback((msgId: number) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, thinkingCollapsed: !m.thinkingCollapsed } : m))
    )
  }, [])

  // -------------------------------------------------------------------------
  // Stream chat with model
  // -------------------------------------------------------------------------

  const streamChat = useCallback(
    async (
      chatMessages: ChatMessage[],
      onUpdate: (content: string) => void,
      signal?: AbortSignal
    ): Promise<string> => {
      const apiMessages = chatMessages
        .filter((m) => !m.isStreaming)
        .map((m) => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/employee/tools/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Locale': locale },
        body: JSON.stringify({
          modelId: selectedModelId,
          messages: apiMessages,
          apiKeys: apiKeys?.filter((k) => k.name && k.value),
          connections: availableConnectionsRef.current
            .filter((c) => selectedConnIdsRef.current.has(c.id))
            .map((c) => ({
              name: c.name,
              type: c.type,
              dbType: c.dbType,
              typeLabel: c.typeLabel,
              envVars: c.envVars,
            })),
        }),
        signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: t('skills.generatorRequestFailed') }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // Non-streaming fallback
        const data = await res.json()
        const raw = data.content || data.chunk || ''
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
        onUpdate(content)
        return content
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let buffer = ''

      while (true) {
        if (signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''

        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            // Support multiple SSE formats
            const rawChunk = parsed.chunk ?? parsed.choices?.[0]?.delta?.content ?? ''
            const chunk = typeof rawChunk === 'string' ? rawChunk : JSON.stringify(rawChunk)
            if (chunk) {
              accumulated += chunk
              onUpdate(accumulated)
            }
            if (parsed.done) break
          } catch {
            // skip
          }
        }
      }

      return accumulated
    },
    [selectedModelId, apiKeys, availableConnections, selectedConnIds]
  )

  // -------------------------------------------------------------------------
  // Send message (user or system)
  // -------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (userContent: string, files?: File[]) => {
      if (!selectedModelId) return

      // Handle user reply in confirmation phase (security / file validation)
      if (phase === 'need-confirm' && pendingConfirmRef.current) {
        const isConfirm = new RegExp(`^(${zhConfirmWordsStr}|yes|ok)$`, 'i').test(
          userContent.trim()
        )
        const confirmType = pendingConfirmRef.current.type ?? 'security'
        const userMsg: ChatMessage = { id: nextId(), role: 'user', content: userContent }
        setMessages((prev) => [...prev, userMsg])

        if (confirmType === 'file-verify') {
          // File validation scenario
          if (isConfirm) {
            // User confirms file correct, tool ready
            const tool = pendingConfirmRef.current.tool
            pendingConfirmRef.current = null
            const successMsg: ChatMessage = {
              id: nextId(),
              role: 'assistant',
              content: t('skills.generatorFileVerifyPassed'),
              testResult: { success: true },
              phaseBadge: t('skills.generatorBadgeVerifyPassed'),
            }
            setMessages((prev) => [...prev, successMsg])
            setCurrentTool(tool)
            setPhase('done')
          } else {
            // User reports file issue, store feedback in ref, useEffect triggers fix
            pendingConfirmRef.current = {
              ...pendingConfirmRef.current!,
              type: 'security', // reuse confirmed phase to trigger fixRequest
              chatHistory: [...pendingConfirmRef.current!.chatHistory, userMsg],
            }
            // Store user feedback for fix
            fileFixFeedbackRef.current = userContent
            setPhase('file-fix')
          }
          return
        }

        // Security confirmation scenario
        if (isConfirm) {
          // Record confirmed security items, skip re-asking for same items
          const tool = pendingConfirmRef.current!.tool
          const paramNames = Object.keys(tool.parameters?.properties ?? {})
          const security = checkSecurity(tool.code, paramNames, tool.language ?? 'javascript')
          for (const c of security.confirmations) {
            confirmedItemsRef.current.add(c)
          }
          // Mark confirmed, useEffect triggers runPipeline
          setPhase('confirmed')
        } else {
          // User rejected, requesting changes
          pendingConfirmRef.current = null
          setPhase('idle')
          const refuseMsg: ChatMessage = {
            id: nextId(),
            role: 'assistant',
            content: t('skills.generatorModifyPrompt'),
            phaseBadge: t('skills.generatorBadgeWaitModify'),
          }
          setMessages((prev) => [...prev, refuseMsg])
        }
        return
      }

      // Add user message
      let content = userContent
      const fileInfos: { name: string; type: string }[] = []

      if (files && files.length > 0) {
        const fileParts: string[] = []
        for (const file of files) {
          fileInfos.push({ name: file.name, type: file.type })
          if (
            file.type.startsWith('text/') ||
            file.name.match(/\.(txt|md|csv|json|xml|yaml|yml|js|ts|py)$/i)
          ) {
            const text = await file.text()
            fileParts.push(`${t('skills.generatorFileLabel', { name: file.name })}\n${text}`)
          } else if (file.type.startsWith('image/')) {
            const base64 = await fileToBase64(file)
            fileParts.push(
              `${t('skills.generatorImageLabel', { name: file.name })}\n(base64 data: ${base64.slice(0, 100)}...)`
            )
          } else if (file.type.startsWith('video/')) {
            fileParts.push(
              t('skills.generatorVideoLabel', {
                name: file.name,
                type: file.type,
                size: (file.size / 1024 / 1024).toFixed(1),
              })
            )
          } else if (file.name.match(/\.(doc|docx)$/i)) {
            fileParts.push(
              t('skills.generatorWordLabel', {
                name: file.name,
                size: (file.size / 1024).toFixed(1),
              })
            )
          } else if (file.name.match(/\.(xls|xlsx)$/i)) {
            fileParts.push(
              t('skills.generatorExcelLabel', {
                name: file.name,
                size: (file.size / 1024).toFixed(1),
              })
            )
          } else {
            fileParts.push(
              t('skills.generatorGenericFileLabel', {
                name: file.name,
                type: file.type,
                size: (file.size / 1024).toFixed(1),
              })
            )
          }
        }
        content = `${userContent}\n\n${fileParts.join('\n\n')}`
      }

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content,
        files: fileInfos.length > 0 ? fileInfos : undefined,
      }

      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        isStreaming: true,
      }

      setMessages((prev) => [...prev, userMsg, assistantMsg])
      setPhase('generating')

      const abort = new AbortController()
      abortRef.current = abort

      try {
        const allMessages = [...messages, userMsg]
        const fullContent = await streamChat(
          allMessages,
          (text) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: text } : m))
            )
          },
          abort.signal
        )

        // Parse thinking & tool from response
        const { thinking, reply } = extractThinking(fullContent)
        const tool = extractToolFromContent(fullContent)

        const finalMsg: ChatMessage = {
          ...assistantMsg,
          content: reply || fullContent,
          thinking: thinking || undefined,
          thinkingCollapsed: true, // auto-collapse after done
          tool: tool || undefined,
          isStreaming: false,
        }

        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? finalMsg : m)))

        // If tool was generated, run security check + auto test
        if (tool) {
          setCurrentTool(tool)
          await runPipeline(tool, [
            ...allMessages,
            { ...finalMsg, id: finalMsg.id, role: 'assistant' as const, content: finalMsg.content },
          ])
        } else {
          setPhase('idle')
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: t('skills.generatorRequestFailedMsg', { msg }),
                  isStreaming: false,
                }
              : m
          )
        )
        setPhase('idle')
      }
    },
    [messages, selectedModelId, nextId, streamChat, phase]
  )

  // -------------------------------------------------------------------------
  // Auto pipeline: security check → test → fix loop
  // -------------------------------------------------------------------------

  const runPipeline = useCallback(
    async (tool: GeneratedTool, chatHistory: ChatMessage[], skipConfirm = false) => {
      // 1. Security check
      setPhase('security-check')
      const secCheckMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: t('skills.generatorSecurityChecking'),
        phaseBadge: t('skills.generatorBadgeSecurityCheck'),
      }
      setMessages((prev) => [...prev, secCheckMsg])
      const paramNames = Object.keys(tool.parameters?.properties ?? {})
      const security = checkSecurity(tool.code, paramNames, tool.language ?? 'javascript')

      if (!security.passed) {
        // Add security errors to chat and auto-fix
        const errMsg = `${t('skills.generatorSecurityFailed')}\n${security.errors.map((e) => `- ${e}`).join('\n')}`
        // Update security check status to failed
        setMessages((prev) =>
          prev.map((m) =>
            m.id === secCheckMsg.id
              ? {
                  ...m,
                  content: t('skills.generatorSecurityFixing'),
                  phaseBadge: t('skills.generatorBadgeSecurityFailed'),
                }
              : m
          )
        )
        const sysMsg: ChatMessage = {
          id: nextId(),
          role: 'user',
          content: `${t('skills.generatorAutoSecurityPrefix')}${errMsg}${t('skills.generatorFixSecuritySuffix')}`,
          phaseBadge: t('skills.generatorBadgeSecurityCheck'),
        }

        setMessages((prev) => [...prev, sysMsg])
        bumpFixCount()

        if (fixCountRef.current >= MAX_FIX) {
          if (regenCountRef.current < MAX_REGEN) {
            bumpRegenCount()
            resetFixCount()
            const regenMsg: ChatMessage = {
              id: nextId(),
              role: 'user',
              content: t('skills.generatorRegenPrompt'),
              phaseBadge: t('skills.generatorBadgeRegen'),
            }
            setMessages((prev) => [...prev, regenMsg])
            return
          }
          setPhase('idle')
          return
        }

        // Auto-send fix request
        await sendFixRequest(errMsg, [...chatHistory, sysMsg])
        return
      }

      // Security check passed, update status
      setMessages((prev) =>
        prev.map((m) =>
          m.id === secCheckMsg.id
            ? {
                ...m,
                content: t('skills.generatorSecurityPassed'),
                phaseBadge: t('skills.generatorBadgeSecurityPassed'),
              }
            : m
        )
      )

      // Security warnings
      if (security.warnings.length > 0) {
        const warnMsg: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          content: `${t('skills.generatorSecurityWarnings')}\n${security.warnings.map((w) => `- ${w}`).join('\n')}`,
          securityResult: security,
          phaseBadge: t('skills.generatorBadgeSecurityCheck'),
        }
        setMessages((prev) => [...prev, warnMsg])
      }

      // Security confirmations - filter confirmed items, remaining need user confirmation
      const newConfirmations = skipConfirm
        ? []
        : security.confirmations.filter((c) => !confirmedItemsRef.current.has(c))
      if (newConfirmations.length > 0) {
        const confirmMsg: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          content: `${t('skills.generatorConfirmPrompt')}\n${newConfirmations.map((c) => `- ${c}`).join('\n')}${t('skills.generatorConfirmSuffix')}`,
          securityResult: security,
          phaseBadge: t('skills.generatorBadgeWaitConfirm'),
        }
        setMessages((prev) => [...prev, confirmMsg])
        pendingConfirmRef.current = { tool, chatHistory, type: 'security' }
        setPhase('need-confirm')
        return
      }

      // 1.5 Database tools must run against a real Connection. The sandbox Pod's
      // localhost has no DB, so without a Connection any DB tool will fail at TCP
      // dial and waste fix attempts on environment errors the LLM cannot resolve.
      if (
        isDatabaseTool(tool.code, tool.parameters?.properties) &&
        selectedConnIdsRef.current.size === 0
      ) {
        setPhase('need-input')
        const dbConns = availableConnectionsRef.current.filter((c) => c.type === 'database')
        const hint =
          dbConns.length > 0
            ? t('skills.generatorNeedDbConnHint', {
                conns: dbConns.map((c) => `「${c.name}」`).join('、'),
              })
            : t('skills.generatorNeedDbConnNoneHint')
        const needConnMsg: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          content: `${t('skills.generatorNeedDbConn')}\n${hint}`,
          phaseBadge: t('skills.generatorBadgeWaitConn'),
        }
        setMessages((prev) => [...prev, needConnMsg])
        pendingConfirmRef.current = { tool, chatHistory, type: 'db-conn' }
        return
      }

      // 2. Check if user input needed (including required and secret params)
      const testParams = tool.testParams ?? {}
      const emptyRequired = (tool.parameters?.required ?? []).filter((k) => !testParams[k])
      // secret params without values also need user input (passwords cannot be empty)
      const emptySecrets = Object.entries(tool.parameters?.properties ?? {})
        .filter(
          ([k, prop]) => prop.secret && !testParams[k] && !(apiKeys ?? []).some((ak) => ak.value)
        )
        .map(([k]) => k)
      const allEmpty = [...new Set([...emptyRequired, ...emptySecrets])]
      if (allEmpty.length > 0) {
        setPhase('need-input')
        const needMsg: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          content: `${t('skills.generatorNeedInput')}\n${allEmpty.map((k) => `- **${k}**${tool.parameters.properties[k]?.secret ? t('skills.generatorSecretLabel') : ''}: ${tool.parameters.properties[k]?.description ?? ''}`).join('\n')}${t('skills.generatorInputFormat', { example: `${allEmpty[0]}=value` })}`,
          phaseBadge: t('skills.generatorBadgeWaitInput'),
        }
        setMessages((prev) => [...prev, needMsg])
        return
      }

      // 3. Auto test — execute via Job-mode runner on the server
      setPhase('testing')
      const prepMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: t('skills.generatorPreparingTest'),
        phaseBadge: t('skills.generatorBadgePrepareTest'),
      }
      setMessages((prev) => [...prev, prepMsg])
      const testMsg = prepMsg
      setMessages((prev) =>
        prev.map((m) =>
          m.id === testMsg.id
            ? {
                ...m,
                content: t('skills.generatorExecutingTest', { params: JSON.stringify(testParams) }),
                phaseBadge: t('skills.generatorBadgeExecuteTest'),
              }
            : m
        )
      )

      try {
        const execParams: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(testParams)) {
          const prop = tool.parameters?.properties?.[key]
          if (prop?.type === 'number') execParams[key] = Number(value) || 0
          else if (prop?.type === 'boolean') execParams[key] = value === 'true'
          else execParams[key] = value
        }

        // Build envVars: inject secret params via env vars
        const envVarsMap: Record<string, string> = {}
        if (tool.parameters?.properties) {
          for (const [key, prop] of Object.entries(tool.parameters.properties)) {
            if (prop.secret) {
              const envName = skillEnvName(key)
              // Prefer values from testParams (passwords etc. filled during testing)
              const testVal = testParams[key]
              if (testVal) {
                envVarsMap[envName] = testVal
                // Secret params not passed via params, removed from execParams
                delete execParams[key]
              } else if (apiKeys) {
                // Then match by name from apiKeys
                const matchedKey =
                  apiKeys.find(
                    (k) => k.name.toLowerCase().includes(key.toLowerCase()) && k.value
                  ) ?? apiKeys.find((k) => k.name && k.value)
                if (matchedKey) {
                  envVarsMap[envName] = matchedKey.value
                }
              }
            }
          }
        }

        // Get selected connection ID, server resolves real config and injects (avoids frontend envValues timing)
        const selectedConnId = Array.from(selectedConnIdsRef.current)[0] ?? undefined

        const res = await fetch('/api/employee/tools/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Locale': locale },
          body: JSON.stringify({
            code: tool.code,
            params: execParams,
            timeout: 30000,
            envVars: envVarsMap,
            language: tool.language ?? 'javascript',
            // Schema is needed server-side so missing connection-bound params get
            // filled from process.env (e.g. CONN_HOST) instead of arriving as undefined.
            parameters: tool.parameters,
            ...(selectedConnId ? { connectionId: selectedConnId } : {}),
          }),
        })
        const data = await res.json()

        if (data.success) {
          const result = data.output?.result
          const resultStr = formatResultStr(result).slice(0, 2000)

          // ---- Result quality validation ----
          // 1) Basic check: null / error field / empty object
          const basicIssue = validateResultBasic(result, t)
          if (basicIssue) {
            // Treat as test failure, trigger fix
            const failMsg: ChatMessage = {
              id: nextId(),
              role: 'assistant',
              content: `${t('skills.generatorExecSuccessInvalid', { issue: basicIssue })}\n${t('skills.generatorResultPrefix')}${resultStr}`,
              testResult: { success: false, error: basicIssue },
              phaseBadge: t('skills.generatorBadgeResultInvalid'),
            }
            setMessages((prev) => prev.map((m) => (m.id === testMsg.id ? failMsg : m)))
            bumpFixCount()
            if (fixCountRef.current >= MAX_FIX) {
              if (regenCountRef.current < MAX_REGEN) {
                bumpRegenCount()
                resetFixCount()
                await sendFixRequest(t('skills.generatorMultiFixRedesign'), [
                  ...chatHistory,
                  failMsg,
                ])
              } else {
                setPhase('idle')
                setMessages((prev) => [
                  ...prev,
                  { id: nextId(), role: 'assistant', content: t('skills.generatorGiveUp') },
                ])
              }
              return
            }
            await sendFixRequest(
              t('skills.generatorExecSuccessWrong', { issue: basicIssue, result: resultStr }),
              [...chatHistory, failMsg]
            )
            return
          }

          // 2) File type result: skip AI validation, let user download and verify
          const fileResult = detectFileResult(result, zhLlmFields)
          if (fileResult) {
            const fileMsg: ChatMessage = {
              id: nextId(),
              role: 'assistant',
              content: t('skills.generatorFileGenSuccess'),
              fileDownload: fileResult,
              testResult: { success: true, result },
              phaseBadge: t('skills.generatorBadgeWaitVerify'),
            }
            setMessages((prev) => prev.map((m) => (m.id === testMsg.id ? fileMsg : m)))
            // Temporarily store context, wait for user reply
            pendingConfirmRef.current = { tool, chatHistory, type: 'file-verify' }
            setPhase('need-confirm')
            return
          }

          // 3) AI semantic validation: let model judge if result matches tool expectations
          setPhase('validating')
          const validateMsg: ChatMessage = {
            id: nextId(),
            role: 'assistant',
            content: t('skills.generatorValidatingResult'),
            phaseBadge: t('skills.generatorBadgeResultValidation'),
          }
          setMessages((prev) => prev.map((m) => (m.id === testMsg.id ? validateMsg : m)))

          const validationPrompt = [
            `[Auto result validation] Tool "${tool.title}" (${tool.description}) was executed with params ${JSON.stringify(testParams)} and returned the following result:`,
            resultStr,
            '',
            'Please judge whether this result is correct and meaningful:',
            '- Does the result contain the core information the tool should return? (e.g. a weather tool should have temperature, conditions, etc.)',
            '- Does the data look real and reasonable? (not placeholders, sample data, or empty shells)',
            '',
            'If the result is correct and meaningful, reply: RESULT_VALID',
            'If the result is incorrect or meaningless, reply: RESULT_INVALID: specific reason',
            'Then provide the fixed complete code (including a ```json code block).',
          ].join('\n')

          const validationUserMsg: ChatMessage = {
            id: nextId(),
            role: 'user',
            content: validationPrompt,
          }
          const validationAssistantMsg: ChatMessage = {
            id: nextId(),
            role: 'assistant',
            content: '',
            isStreaming: true,
          }
          setMessages((prev) => [...prev, validationUserMsg, validationAssistantMsg])

          const abort = new AbortController()
          abortRef.current = abort

          const validationHistory = [...chatHistory, validateMsg, validationUserMsg]
          const validationContent = await streamChat(
            validationHistory,
            (text) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === validationAssistantMsg.id ? { ...m, content: text } : m))
              )
            },
            abort.signal
          )

          const { thinking: valThinking, reply: valReply } = extractThinking(validationContent)
          const valTool = extractToolFromContent(validationContent)

          const valFinalMsg: ChatMessage = {
            ...validationAssistantMsg,
            content: valReply || validationContent,
            thinking: valThinking || undefined,
            thinkingCollapsed: true,
            tool: valTool || undefined,
            isStreaming: false,
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === validationAssistantMsg.id ? valFinalMsg : m))
          )

          if (validationContent.includes('RESULT_VALID')) {
            // Validation passed
            const successMsg: ChatMessage = {
              id: nextId(),
              role: 'assistant',
              content: t('skills.generatorTestPassedMsg', { result: resultStr }),
              testResult: { success: true, result },
              phaseBadge: t('skills.generatorBadgeTestPassed'),
            }
            setMessages((prev) => [...prev, successMsg])
            setPhase('done')
            return
          }

          // AI judged result incorrect, needs fix
          if (valTool) {
            setCurrentTool(valTool)
            await runPipeline(valTool, [...validationHistory, valFinalMsg])
          } else {
            bumpFixCount()
            if (fixCountRef.current >= MAX_FIX) {
              if (regenCountRef.current < MAX_REGEN) {
                bumpRegenCount()
                resetFixCount()
                await sendFixRequest(t('skills.generatorMultiFixRedesign'), [
                  ...validationHistory,
                  valFinalMsg,
                ])
              } else {
                setPhase('idle')
              }
              return
            }
            await sendFixRequest(
              t('skills.generatorResultValidationFailed', { result: resultStr }),
              [...validationHistory, valFinalMsg]
            )
          }
          return
        }

        // Test failed - code execution error
        const errMsg = data.detail || data.error || t('skills.generatorExecutionFailed')
        const failMsg: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          content: t('skills.generatorTestFailed', { error: errMsg }),
          testResult: { success: false, error: errMsg },
          phaseBadge: t('skills.generatorBadgeTestFailed'),
        }
        setMessages((prev) => prev.map((m) => (m.id === testMsg.id ? failMsg : m)))

        // Auto fix
        bumpFixCount()
        if (fixCountRef.current >= MAX_FIX) {
          if (regenCountRef.current < MAX_REGEN) {
            bumpRegenCount()
            resetFixCount()
            await sendFixRequest(t('skills.generatorMultiFixRedesign'), [...chatHistory, failMsg])
          } else {
            setPhase('idle')
            const stopMsg: ChatMessage = {
              id: nextId(),
              role: 'assistant',
              content: t('skills.generatorGiveUp'),
            }
            setMessages((prev) => [...prev, stopMsg])
          }
          return
        }

        await sendFixRequest(
          `${t('skills.generatorTestFailed', { error: errMsg })}\n${t('skills.generatorFixSecuritySuffix')}`,
          [...chatHistory, failMsg]
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === testMsg.id
              ? {
                  ...m,
                  content: t('skills.generatorTestException', { msg }),
                  phaseBadge: t('skills.generatorBadgeTestException'),
                }
              : m
          )
        )
        setPhase('idle')
      }
    },
    [nextId, bumpFixCount, resetFixCount, bumpRegenCount, streamChat]
  )

  // After user confirms security, trigger runPipeline to continue (skipConfirm=true)
  useEffect(() => {
    if (phase !== 'confirmed' || !pendingConfirmRef.current) return
    const { tool, chatHistory } = pendingConfirmRef.current
    pendingConfirmRef.current = null
    runPipeline(tool, chatHistory, true)
  }, [phase, runPipeline])

  // Resume pipeline after the user picks a database connection for a DB tool that
  // was paused (need-input + pendingConfirmRef.type==='db-conn').
  useEffect(() => {
    if (phase !== 'need-input') return
    if (pendingConfirmRef.current?.type !== 'db-conn') return
    if (selectedConnIds.size === 0) return
    const hasDbConn = Array.from(selectedConnIds).some(
      (id) => availableConnectionsRef.current.find((c) => c.id === id)?.type === 'database'
    )
    if (!hasDbConn) return
    const { tool, chatHistory } = pendingConfirmRef.current
    pendingConfirmRef.current = null
    runPipeline(tool, chatHistory, true)
  }, [phase, selectedConnIds, runPipeline])

  const sendFixRequest = useCallback(
    async (errorContext: string, history: ChatMessage[]) => {
      setPhase('fixing')
      const fixMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: `${t('skills.generatorAutoFix')}${errorContext}`,
        phaseBadge: t('skills.generatorBadgeAutoFix'),
      }
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: '',
        isStreaming: true,
      }

      setMessages((prev) => [...prev, fixMsg, assistantMsg])

      const abort = new AbortController()
      abortRef.current = abort

      try {
        const allMessages = [...history, fixMsg]
        const fullContent = await streamChat(
          allMessages,
          (text) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: text } : m))
            )
          },
          abort.signal
        )

        const { thinking, reply } = extractThinking(fullContent)
        const tool = extractToolFromContent(fullContent)

        const finalMsg: ChatMessage = {
          ...assistantMsg,
          content: reply || fullContent,
          thinking: thinking || undefined,
          thinkingCollapsed: true,
          tool: tool || undefined,
          isStreaming: false,
        }

        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? finalMsg : m)))

        if (tool) {
          setCurrentTool(tool)
          await runPipeline(tool, [...allMessages, finalMsg])
        } else {
          setPhase('idle')
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: t('skills.generatorFixRequestFailed', {
                    msg: err instanceof Error ? err.message : String(err),
                  }),
                  isStreaming: false,
                }
              : m
          )
        )
        setPhase('idle')
      }
    },
    [nextId, streamChat, runPipeline]
  )

  // User reports file issue, trigger fix
  useEffect(() => {
    if (phase !== 'file-fix' || !pendingConfirmRef.current || !fileFixFeedbackRef.current) return
    const feedback = fileFixFeedbackRef.current
    const { chatHistory } = pendingConfirmRef.current
    pendingConfirmRef.current = null
    fileFixFeedbackRef.current = null
    sendFixRequest(t('skills.generatorFileFixPrompt', { feedback }), chatHistory)
  }, [phase, sendFixRequest])

  // -------------------------------------------------------------------------
  // Import trigger: after dialog opens, trigger AI analysis with hidden context (no user message shown)
  // Supports GitHub project zip and Markdown/TXT document sources
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open || !importProjectContext || !selectedModelId || importContextSentRef.current) return
    importContextSentRef.current = true

    // Predict connection type from import content, auto-select matching connection
    // Use preloadedConnections (prop) directly since availableConnections (state) may not be init yet
    // Also ensure availableConnectionsRef has data for streamChat to read
    const connSource = preloadedConnections ?? []
    if (availableConnectionsRef.current.length === 0 && connSource.length > 0) {
      const conns = connSource.map((c) => {
        const typeLabel = CONNECTION_TYPE_I18N_KEYS[c.type as ConnectionType]
          ? t(CONNECTION_TYPE_I18N_KEYS[c.type as ConnectionType])
          : c.type
        const envVars: Array<{ envName: string; label: string }> = []
        for (const [key, val] of Object.entries(c.config)) {
          if (val !== undefined && val !== null && String(val).trim()) {
            const envName = `CONN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
            envVars.push({ envName, label: key })
          }
        }
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          typeLabel,
          dbType: c.type === 'database' ? (c.config.dbType as string | undefined) : undefined,
          envVars,
          envValues: {},
        } satisfies SelectedConnection
      })
      setAvailableConnections(conns)
      availableConnectionsRef.current = conns
    }
    if (connSource.length > 0 && selectedConnIdsRef.current.size === 0) {
      const content = (importProjectContext.readme ?? '').toLowerCase()
      const connKeywords: Record<string, { type: string; dbType?: string }> = {
        mysql: { type: 'database', dbType: 'mysql' },
        mariadb: { type: 'database', dbType: 'mariadb' },
        postgresql: { type: 'database', dbType: 'postgresql' },
        postgres: { type: 'database', dbType: 'postgresql' },
        mongodb: { type: 'database', dbType: 'mongodb' },
        mongo: { type: 'database', dbType: 'mongodb' },
        redis: { type: 'database', dbType: 'redis' },
        sqlserver: { type: 'database', dbType: 'sqlserver' },
        mssql: { type: 'database', dbType: 'sqlserver' },
        oracle: { type: 'database', dbType: 'oracle' },
        conn_host: { type: 'database' },
        conn_username: { type: 'database' },
      }
      for (const [keyword, ct] of Object.entries(connKeywords)) {
        if (content.includes(keyword)) {
          const match = connSource.find((c) => {
            if (c.type !== ct.type) return false
            if (ct.dbType) {
              const cDbType =
                c.type === 'database' ? (c.config.dbType as string | undefined) : undefined
              if (cDbType !== ct.dbType) return false
            }
            return true
          })
          if (match) {
            setSelectedConnIds(new Set([match.id]))
            break
          }
        }
      }
    }

    let parts: string[]

    if (importProjectContext.source === 'skill-zip') {
      // ---- Skill zip import: send original code for AI to rewrite ----
      const lang = importProjectContext.language === 'python' ? 'Python' : 'JavaScript'
      parts = [
        `I imported a tool package "${importProjectContext.projectName}". Please rewrite it as a deployable CrewMeld tool for the current project.`,
        '',
        '## Tool Description',
        importProjectContext.readme ?? '',
        '',
      ]
      if (importProjectContext.originalParameters) {
        parts.push(
          '## Original Parameter Schema',
          '```json',
          JSON.stringify(importProjectContext.originalParameters, null, 2),
          '```',
          ''
        )
      }
      if (importProjectContext.originalCode) {
        parts.push(
          `## Original Code (${lang})`,
          '```',
          importProjectContext.originalCode,
          '```',
          ''
        )
      }
      parts.push(
        '---',
        'Please rewrite the tool based on the above information:',
        `1. Tool code uses ${lang}, parameters are injected via local variables (do not use module.exports), must have a return statement`,
        '2. If the tool produces file-type content (images, Excel, PDF, CSV, QR codes, etc.), it must upload to MinIO and return a download link, strictly following the "File generation tool specification" in the system prompt. Returning Base64 is strictly forbidden',
        '3. When generating download links, must use GetObjectCommand (not PutObjectCommand); the signed URL is for the user to download',
        "4. Preserve the original tool's core functionality and parameter design"
      )
    } else if (importProjectContext.source === 'markdown') {
      // ---- Markdown / TXT document import ----
      parts = [
        `I uploaded a document "${importProjectContext.projectName}". Please generate a deployable CrewMeld tool based on the document content.`,
        '',
        '## Document Content',
        '```',
        importProjectContext.readme ?? '',
        '```',
        '',
        '---',
        'Based on the above document:',
        '1. Analyze the functionality described in the document',
        '2. Generate a tool that implements the core functionality described in the document',
        '3. Tool code uses JavaScript or Python',
        '4. If the tool produces file-type content (images, Excel, PDF, CSV, etc.), it must upload to MinIO and return a download link, strictly following the "File generation tool specification" in the system prompt',
        '5. When generating download links, must use GetObjectCommand (not PutObjectCommand); the signed URL is for the user to download',
      ]
    } else {
      // ---- GitHub project zip import (original logic) ----
      parts = [
        `I uploaded the source code package of a GitHub project "${importProjectContext.projectName}". Please analyze this project and generate a deployable CrewMeld tool.`,
        `Project language: ${importProjectContext.language === 'python' ? 'Python' : 'JavaScript/Node.js'}`,
        '',
      ]
      if (importProjectContext.readme) {
        parts.push('## README (Summary)', '```', importProjectContext.readme, '```', '')
      }
      if (importProjectContext.depsFile) {
        parts.push(
          `## Dependencies (${importProjectContext.depsFileName})`,
          '```',
          importProjectContext.depsFile,
          '```',
          ''
        )
      }
      if (importProjectContext.entryPoint) {
        parts.push(
          `## Entry Point (${importProjectContext.entryPointName})`,
          '```',
          importProjectContext.entryPoint,
          '```',
          ''
        )
      }
      if (importProjectContext.examples && importProjectContext.examples.length > 0) {
        parts.push('## Example Code')
        for (const ex of importProjectContext.examples) {
          parts.push(`### ${ex.name}`, '```', ex.content, '```', '')
        }
      }
      parts.push(
        '---',
        'Based on the above information:',
        '1. Analyze all core functionalities of this project',
        '2. Generate **one** tool that encapsulates all functionalities as different interfaces (differentiated by an action parameter or similar field)',
        `3. Tool code uses ${importProjectContext.language === 'python' ? 'Python' : 'JavaScript'}`,
        `4. Install the library via ${importProjectContext.language === 'python' ? 'pip install --break-system-packages' : 'npm install'} (package name: ${importProjectContext.projectName}), then import and call it in the code`
      )
    }

    // No user message bubble, send project summary as hidden system message to trigger AI analysis
    const hiddenMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: parts.join('\n'),
      hidden: true,
    }

    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: '',
      isStreaming: true,
    }

    setMessages([hiddenMsg, assistantMsg])
    setPhase('generating')

    const abort = new AbortController()
    abortRef.current = abort

    streamChat(
      [hiddenMsg],
      (text) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: text } : m))
        )
      },
      abort.signal
    )
      .then((fullContent) => {
        const { thinking, reply } = extractThinking(fullContent)
        const tool = extractToolFromContent(fullContent)

        const finalMsg: ChatMessage = {
          ...assistantMsg,
          content: reply || fullContent,
          thinking: thinking || undefined,
          thinkingCollapsed: true,
          tool: tool || undefined,
          isStreaming: false,
        }
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? finalMsg : m)))

        if (tool) {
          setCurrentTool(tool)
          runPipeline(tool, [hiddenMsg, { ...finalMsg, role: 'assistant' as const }])
        } else {
          setPhase('idle')
        }
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
        const errMsg = err instanceof Error ? err.message : String(err)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: t('skills.generatorRequestFailedMsg', { msg: errMsg }),
                  isStreaming: false,
                }
              : m
          )
        )
        setPhase('idle')
      })
  }, [open, importProjectContext, selectedModelId, nextId, streamChat, runPipeline])

  // -------------------------------------------------------------------------
  // User submit
  // -------------------------------------------------------------------------

  const handleSubmit = useCallback(() => {
    const text = input.trim()
    if (!text || phase === 'generating' || phase === 'fixing') return
    setInput('')
    // Reset scroll-up state after user sends message, auto-follow new content
    userScrolledUpRef.current = false
    setShowScrollBtn(false)
    sendMessage(text)
  }, [input, phase, sendMessage])

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      const text =
        input.trim() ||
        t('skills.generatorAnalyzeFiles', {
          files: Array.from(files)
            .map((f) => f.name)
            .join(', '),
        })
      setInput('')
      sendMessage(text, Array.from(files))
      e.target.value = ''
    },
    [input, sendMessage]
  )

  const handleAccept = useCallback(() => {
    if (currentTool) {
      // Pass selected connection config as connectionEnvVars (Map dedup, later overrides earlier)
      const envMap = new Map<string, string>()
      let connectorType: { type: string; dbType?: string } | undefined
      let hasConnection = false
      const connEnvKeys = new Set<string>()
      for (const conn of availableConnections) {
        if (selectedConnIds.has(conn.id)) {
          hasConnection = true
          for (const [envName, envVal] of Object.entries(conn.envValues)) {
            envMap.set(envName, envVal)
            connEnvKeys.add(envName)
          }
          // Record first selected connection type as tool connection type requirement
          if (!connectorType) {
            connectorType = { type: conn.type, ...(conn.dbType ? { dbType: conn.dbType } : {}) }
          }
        }
      }
      const connEnvVars = Array.from(envMap.entries()).map(([name, value]) => ({ name, value }))

      // Tag each parameter with the env-var name the deployed pod should fall back to
      // when the request body omits it. Without this, secret/connection-bound params
      // arrive as `undefined` at the tool code (e.g. mysql2 throws ERR_INVALID_ARG_TYPE
      // when password is undefined).
      // Mapping rules:
      //   - prop.secret === true        → CREWMELD_<KEY>
      //   - matches a connection env    → CONN_<KEY> (only when a connection is selected)
      // Common DB-param aliases (user→username) are normalized so connection values reach them.
      const DB_PARAM_ALIASES: Record<string, string> = {
        user: 'username',
        pwd: 'password',
        db: 'database',
        dbName: 'database',
        databaseName: 'database',
      }
      const paramsWithEnv: GeneratedTool['parameters']['properties'] = {}
      for (const [paramName, prop] of Object.entries(currentTool.parameters?.properties ?? {})) {
        let envName: string | undefined
        // Connection-bound param (e.g. password matching CONN_PASSWORD) wins over a
        // secret-tagged CREWMELD_* fallback so the real connection value reaches
        // the tool, not whatever placeholder the user typed during testing.
        if (hasConnection) {
          const canonical = DB_PARAM_ALIASES[paramName] ?? paramName
          const candidate = configKeyToEnvName(canonical)
          if (connEnvKeys.has(candidate)) envName = candidate
        }
        if (!envName && prop.secret) {
          envName = skillEnvName(paramName)
        }
        paramsWithEnv[paramName] = envName ? { ...prop, envName } : prop
      }

      const updatedTool: GeneratedTool = {
        ...currentTool,
        parameters: {
          ...currentTool.parameters,
          properties: paramsWithEnv,
        },
      }

      onCreated?.({
        ...updatedTool,
        connectionEnvVars: connEnvVars.length > 0 ? connEnvVars : undefined,
        connectorType,
      })
      handleClose()
    }
  }, [currentTool, onCreated, handleClose, availableConnections, selectedConnIds])

  // -------------------------------------------------------------------------
  // Trial run
  // -------------------------------------------------------------------------

  const handleTrialRun = useCallback(async () => {
    if (!currentTool) return

    // Must pass security check before trial run
    const paramNames = Object.keys(currentTool.parameters?.properties ?? {})
    const security = checkSecurity(
      currentTool.code,
      paramNames,
      currentTool.language ?? 'javascript'
    )
    if (!security.passed) {
      const errContent = `${t('skills.generatorSecurityBlockTrialRun')}\n${security.errors.map((e) => `- ${e}`).join('\n')}`
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant' as const,
          content: errContent,
          securityResult: security,
          phaseBadge: t('skills.generatorBadgeSecurityFailed'),
        },
      ])
      return
    }

    setPhase('testing')
    const params = trialParams
    const execParams: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(params)) {
      const prop = currentTool.parameters?.properties?.[key]
      if (prop?.type === 'number') execParams[key] = Number(value) || 0
      else if (prop?.type === 'boolean') execParams[key] = value === 'true'
      else execParams[key] = value
    }

    // Build envVars for trial: secret params from trialParams
    const trialEnvVars: Record<string, string> = {}
    if (currentTool.parameters?.properties) {
      for (const [key, prop] of Object.entries(currentTool.parameters.properties)) {
        if (prop.secret) {
          const envName = skillEnvName(key)
          const testVal = trialParams[key]
          if (testVal) {
            trialEnvVars[envName] = testVal
            delete execParams[key]
          } else if (apiKeys) {
            const matchedKey =
              apiKeys.find((k) => k.name.toLowerCase().includes(key.toLowerCase()) && k.value) ??
              apiKeys.find((k) => k.name && k.value)
            if (matchedKey) {
              trialEnvVars[envName] = matchedKey.value
            }
          }
        }
      }
    }

    // Get selected connection ID, server resolves real config and injects
    const trialConnId = Array.from(selectedConnIdsRef.current)[0] ?? undefined

    const resultMsg: ChatMessage = {
      id: nextId(),
      role: 'assistant',
      content: t('skills.generatorTrialRunning'),
      phaseBadge: t('skills.generatorBadgeTrialRun'),
    }
    setMessages((prev) => [...prev, resultMsg])

    try {
      const res = await fetch('/api/employee/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Locale': locale },
        body: JSON.stringify({
          code: currentTool.code,
          params: execParams,
          timeout: 30000,
          envVars: trialEnvVars,
          language: currentTool.language ?? 'javascript',
          // Schema lets server fill CONN_*/CREWMELD_* env values for params the
          // user form omitted (avoids undefined reaching driver code like mysql2).
          parameters: currentTool.parameters,
          ...(trialConnId ? { connectionId: trialConnId } : {}),
        }),
      })
      const data = await res.json()
      const resultStr = data.success
        ? t('skills.generatorTrialRunSuccess', {
            result: formatResultStr(data.output?.result).slice(0, 2000),
          })
        : t('skills.generatorTrialRunFailed', { error: data.detail || data.error })

      setMessages((prev) =>
        prev.map((m) =>
          m.id === resultMsg.id
            ? {
                ...m,
                content: resultStr,
                testResult: data.success
                  ? { success: true, result: data.output?.result }
                  : { success: false, error: data.detail || data.error },
                phaseBadge: data.success
                  ? t('skills.generatorBadgeTrialRunSuccess')
                  : t('skills.generatorBadgeTrialRunFailed'),
              }
            : m
        )
      )
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === resultMsg.id
            ? {
                ...m,
                content: t('skills.generatorTrialRunException', {
                  msg: err instanceof Error ? err.message : String(err),
                }),
                phaseBadge: t('skills.generatorBadgeTrialRunException'),
              }
            : m
        )
      )
    }
    setPhase('done')
  }, [currentTool, trialParams, nextId, apiKeys])

  // -------------------------------------------------------------------------
  // Download package
  // -------------------------------------------------------------------------

  const handleDownload = useCallback(async () => {
    if (!currentTool) return
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const version = `V1.0.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`

    const manifest = {
      id: `ai-tool-${Date.now()}`,
      name: currentTool.title,
      description: currentTool.description,
      version,
      language: 'javascript',
      author: t('skills.generatorAuthorAI'),
      category: t('skills.generatorCategoryAI'),
      createdAt: new Date().toISOString().slice(0, 10),
      parameters: currentTool.parameters,
    }

    const serverCode = [
      "import { createServer } from 'http';",
      "import { readFileSync } from 'fs';",
      '',
      "const toolCode = readFileSync('/app/tool.js', 'utf-8');",
      'const SAFE_IDENT = /^[\\p{L}_$][\\p{L}\\p{N}_$]*$/u;',
      '',
      'const server = createServer(async (req, res) => {',
      "  res.setHeader('Access-Control-Allow-Origin', '*');",
      "  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');",
      "  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');",
      "  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }",
      "  if (req.method === 'GET' && req.url === '/health') {",
      "    res.writeHead(200, { 'Content-Type': 'application/json' });",
      "    res.end(JSON.stringify({ status: 'ok' }));",
      '    return;',
      '  }',
      "  if (req.method === 'POST') {",
      "    let body = '';",
      '    for await (const chunk of req) body += chunk;',
      '    try {',
      '      const params = JSON.parse(body);',
      '      for (const key of Object.keys(params)) {',
      "        if (!SAFE_IDENT.test(key)) throw new Error('Invalid param: ' + key);",
      '      }',
      "      const paramDefs = Object.keys(params).map(k => 'const ' + k + ' = __p__[' + JSON.stringify(k) + '];').join('\\n');",
      "      const fn = new Function('__p__', 'fetch', 'return (async () => {\\n' + paramDefs + '\\n' + toolCode + '\\n})()');",
      '      const result = await fn(params, globalThis.fetch);',
      "      res.writeHead(200, { 'Content-Type': 'application/json' });",
      '      res.end(JSON.stringify({ success: true, result }));',
      '    } catch (err) {',
      "      res.writeHead(500, { 'Content-Type': 'application/json' });",
      '      res.end(JSON.stringify({ success: false, error: err.message }));',
      '    }',
      '    return;',
      '  }',
      "  res.writeHead(404); res.end('Not Found');",
      '});',
      "server.listen(3000, () => console.log('Tool server on :3000'));",
    ].join('\n')

    const paramDocs = Object.entries(currentTool.parameters?.properties ?? {})
      .map(([k, v]) => `- \`${k}\` (${v.type}): ${v.description}`)
      .join('\n')
    const testCmd = JSON.stringify(currentTool.testParams ?? {})
    const readme = [
      `# ${currentTool.title}`,
      '',
      currentTool.description,
      '',
      `## ${t('skills.generatorReadmeParams')}`,
      '',
      paramDocs,
      '',
      `## ${t('skills.generatorReadmeUsage')}`,
      '',
      '```bash',
      'node server.mjs',
      '```',
      '',
      '```bash',
      `curl -X POST http://localhost:3000 -H "Content-Type: application/json" -d \'${testCmd}\'`,
      '```',
    ].join('\n')

    // Dynamic import JSZip
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('manifest.json', JSON.stringify(manifest, null, 2))
      zip.file('tool.js', currentTool.code)
      zip.file('server.mjs', serverCode)
      zip.file('README.md', readme)
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tool-${manifest.id}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Fallback: download just the code
      const blob = new Blob([currentTool.code], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${currentTool.title}.js`
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [currentTool])

  /** Render inline markdown: bold, inline code */
  const renderInline = useCallback((text: string, keyPrefix: string) => {
    // Split inline code `...` and bold **...**
    const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    return tokens.map((tok, j) => {
      if (tok.startsWith('`') && tok.endsWith('`')) {
        return (
          <code
            key={`${keyPrefix}-${j}`}
            className='rounded bg-gray-200 px-1.5 py-0.5 text-gray-700 text-xs'
          >
            {tok.slice(1, -1)}
          </code>
        )
      }
      if (tok.startsWith('**') && tok.endsWith('**')) {
        return <strong key={`${keyPrefix}-${j}`}>{tok.slice(2, -2)}</strong>
      }
      return <span key={`${keyPrefix}-${j}`}>{tok}</span>
    })
  }, [])

  /** Render message content: code blocks, bold, lists */
  const renderContent = useCallback(
    (text: string) => {
      // Split fenced code blocks ```...``` and plain text
      const parts = text.split(/(```[\s\S]*?```)/g)
      return parts.map((part, i) => {
        // Fenced code block
        const fenceMatch = part.match(/^```(\w*)\n?([\s\S]*?)```$/)
        if (fenceMatch) {
          return (
            <pre
              key={i}
              className='my-2 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-3 text-gray-700 text-xs leading-relaxed'
            >
              <code>{fenceMatch[2]}</code>
            </pre>
          )
        }
        // Process by line: identify list items
        const lines = part.split('\n')
        const elements: React.ReactNode[] = []
        let listBuffer: string[] = []

        const flushList = () => {
          if (listBuffer.length === 0) return
          elements.push(
            <ul key={`${i}-ul-${elements.length}`} className='my-1 ml-4 list-disc space-y-0.5'>
              {listBuffer.map((item, li) => (
                <li key={li}>{renderInline(item, `${i}-li-${li}`)}</li>
              ))}
            </ul>
          )
          listBuffer = []
        }

        for (let l = 0; l < lines.length; l++) {
          const line = lines[l]
          const listMatch = line.match(/^[-*]\s+(.+)$/)
          if (listMatch) {
            listBuffer.push(listMatch[1])
          } else {
            flushList()
            // Normal line: render inline markdown
            if (l > 0) elements.push(<br key={`${i}-br-${l}`} />)
            elements.push(<span key={`${i}-ln-${l}`}>{renderInline(line, `${i}-${l}`)}</span>)
          }
        }
        flushList()

        return <span key={i}>{elements}</span>
      })
    },
    [renderInline]
  )

  if (!open) return null

  const selectedModel = models.find((m) => m.id === selectedModelId)
  const isWorking =
    phase === 'generating' ||
    phase === 'testing' ||
    phase === 'validating' ||
    phase === 'fixing' ||
    phase === 'security-check'

  return (
    <div className='fade-in fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/40 duration-200'>
      <div className='zoom-in-95 slide-in-from-bottom-2 relative flex h-[90vh] w-[1100px] max-w-[95vw] animate-in flex-col rounded-2xl bg-white shadow-2xl duration-200'>
        {/* Header */}
        <div className='flex items-center justify-between border-b px-6 py-3'>
          <div className='flex items-center gap-3'>
            <div className='flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50'>
              <Sparkles className='h-4 w-4 text-violet-600' />
            </div>
            <h2 className='font-semibold text-gray-900 text-sm'>{t('skills.aiNewTool')}</h2>
            {/* Model selector */}
            <div className='relative ml-4'>
              <button
                type='button'
                disabled={isWorking}
                onClick={() => setModelDropdownOpen((v) => !v)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs',
                  models.length === 0
                    ? 'border-red-200 text-red-500'
                    : 'border-gray-200 text-gray-700',
                  isWorking && 'opacity-60'
                )}
                data-testid='dialog:ai-tool-generator:select:model'
              >
                <Bot className='h-3.5 w-3.5' />
                <span className='max-w-[200px] truncate'>
                  {models.length === 0
                    ? t('skills.aiNoModels')
                    : selectedModel
                      ? selectedModel.displayName
                      : t('skills.aiSelectModel')}
                </span>
                <ChevronDown className='h-3 w-3' />
              </button>
              {modelDropdownOpen && models.length > 0 && (
                <div className='absolute top-full left-0 z-10 mt-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg'>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      type='button'
                      onClick={() => {
                        setSelectedModelId(m.id)
                        BrowserStorage.setItem(STORAGE_KEYS.LAST_SELECTED_MODEL, m.id)
                        setModelDropdownOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50',
                        m.id === selectedModelId && 'bg-violet-50 text-violet-700'
                      )}
                    >
                      <Bot className='h-3.5 w-3.5 shrink-0 text-gray-400' />
                      <span className='font-medium'>{m.displayName}</span>
                      {m.modelName && <span className='text-gray-400'>{m.modelName}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Connection selector */}
            {availableConnections.length > 0 && (
              <div className='relative ml-2' ref={connDropdownRef}>
                <button
                  type='button'
                  disabled={isWorking}
                  onClick={() => {
                    setConnDropdownOpen((v) => {
                      if (!v) {
                        setConnLevel('type')
                        setConnSelectedType(null)
                        setConnSelectedDbType(null)
                      }
                      return !v
                    })
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs',
                    selectedConnIds.size > 0
                      ? 'border-green-200 bg-green-50 text-green-700'
                      : 'border-gray-200 text-gray-700',
                    isWorking && 'opacity-60'
                  )}
                  data-testid='dialog:ai-tool-generator:select:connection'
                >
                  <PlugZap className='h-3.5 w-3.5' />
                  <span className='max-w-[160px] truncate'>
                    {selectedConnIds.size > 0
                      ? t('skills.aiConnectionCount', { count: selectedConnIds.size })
                      : t('skills.aiSelectConnection')}
                  </span>
                  <ChevronDown className='h-3 w-3' />
                </button>
                {connDropdownOpen &&
                  (() => {
                    // Build available type list (only show types with connections)
                    const typeMap = new Map<string, SelectedConnection[]>()
                    for (const c of availableConnections)
                      typeMap.set(c.type, [...(typeMap.get(c.type) ?? []), c])
                    // Database subtypes
                    const dbTypeMap = new Map<string, SelectedConnection[]>()
                    for (const c of availableConnections) {
                      if (c.type === 'database' && c.dbType)
                        dbTypeMap.set(c.dbType, [...(dbTypeMap.get(c.dbType) ?? []), c])
                    }
                    const hasDbSubtypes = dbTypeMap.size > 0

                    // Connection list for current level
                    const pickList =
                      connSelectedType === 'database' && connSelectedDbType
                        ? availableConnections.filter(
                            (c) => c.type === 'database' && c.dbType === connSelectedDbType
                          )
                        : connSelectedType
                          ? availableConnections.filter(
                              (c) =>
                                c.type === connSelectedType &&
                                (c.type !== 'database' || !hasDbSubtypes)
                            )
                          : []

                    const toggleConn = (id: string) => {
                      const target = availableConnections.find((c) => c.id === id)
                      setSelectedConnIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(id)) {
                          next.delete(id)
                        } else {
                          // Same-type connections are mutually exclusive: deselect same-type when selecting new
                          // Database split by dbType, others by type
                          if (target) {
                            for (const otherId of prev) {
                              const other = availableConnections.find((c) => c.id === otherId)
                              if (!other) continue
                              const sameType = other.type === target.type
                              // Database: all DB connections mutually exclusive (different dbType CONN_* vars conflict)
                              if (sameType && target.type === 'database') {
                                next.delete(otherId)
                                continue
                              }
                              // Non-database: same type mutually exclusive
                              if (sameType) {
                                next.delete(otherId)
                              }
                            }
                          }
                          next.add(id)
                        }
                        return next
                      })
                    }

                    // Breadcrumb path
                    const breadcrumb: Array<{ label: string; onClick: () => void }> = []
                    if (connLevel !== 'type') {
                      breadcrumb.push({
                        label: t('skills.aiConnectionTypeLabel'),
                        onClick: () => {
                          setConnLevel('type')
                          setConnSelectedType(null)
                          setConnSelectedDbType(null)
                        },
                      })
                    }
                    if (
                      connLevel === 'pick' &&
                      connSelectedType === 'database' &&
                      connSelectedDbType
                    ) {
                      breadcrumb.push({
                        label: CONNECTION_TYPE_I18N_KEYS[connSelectedType as ConnectionType]
                          ? t(CONNECTION_TYPE_I18N_KEYS[connSelectedType as ConnectionType])
                          : connSelectedType,
                        onClick: () => {
                          setConnLevel('dbType')
                          setConnSelectedDbType(null)
                        },
                      })
                    }

                    return (
                      <div className='absolute top-full left-0 z-10 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg'>
                        {/* Breadcrumb navigation */}
                        {breadcrumb.length > 0 && (
                          <div className='flex items-center gap-1 border-gray-100 border-b px-3 py-1.5 text-[11px] text-gray-400'>
                            {breadcrumb.map((bc, i) => (
                              <span key={i} className='flex items-center gap-1'>
                                <button
                                  type='button'
                                  onClick={bc.onClick}
                                  className='text-blue-500 hover:text-blue-700 hover:underline'
                                >
                                  {bc.label}
                                </button>
                                <ChevronRight className='h-3 w-3' />
                              </span>
                            ))}
                            <span className='font-medium text-gray-600'>
                              {connLevel === 'dbType' && t('skills.aiSelectDbType')}
                              {connLevel === 'pick' &&
                                (connSelectedType === 'database' && connSelectedDbType
                                  ? (DATABASE_SUBTYPE_LABELS[
                                      connSelectedDbType as DatabaseSubtype
                                    ] ?? connSelectedDbType)
                                  : CONNECTION_TYPE_I18N_KEYS[connSelectedType as ConnectionType]
                                    ? t(
                                        CONNECTION_TYPE_I18N_KEYS[
                                          connSelectedType as ConnectionType
                                        ]
                                      )
                                    : connSelectedType)}
                            </span>
                          </div>
                        )}

                        <div className='max-h-56 overflow-y-auto'>
                          {/* Level 1: select connection type */}
                          {connLevel === 'type' && (
                            <>
                              <div className='border-gray-100 border-b px-3 py-2 text-[11px] text-gray-400'>
                                {t('skills.aiSelectConnectionType')}
                              </div>
                              {Array.from(typeMap.entries()).map(([type, conns]) => {
                                const icon = CONNECTION_TYPE_ICONS[type as ConnectionType] ?? '🔗'
                                const label = CONNECTION_TYPE_I18N_KEYS[type as ConnectionType]
                                  ? t(CONNECTION_TYPE_I18N_KEYS[type as ConnectionType])
                                  : type
                                const count = conns.length
                                const selectedCount = conns.filter((c) =>
                                  selectedConnIds.has(c.id)
                                ).length
                                return (
                                  <button
                                    key={type}
                                    type='button'
                                    onClick={() => {
                                      setConnSelectedType(type)
                                      if (type === 'database' && hasDbSubtypes) {
                                        setConnLevel('dbType')
                                      } else {
                                        setConnLevel('pick')
                                      }
                                    }}
                                    className='flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors hover:bg-gray-50'
                                  >
                                    <span className='text-base'>{icon}</span>
                                    <span className='flex-1 font-medium text-gray-800'>
                                      {label}
                                    </span>
                                    <span className='text-[11px] text-gray-400'>
                                      {t('skills.aiConnectionCount', { count })}
                                    </span>
                                    {selectedCount > 0 && (
                                      <span className='rounded-full bg-green-100 px-1.5 py-0.5 font-medium text-[10px] text-green-700'>
                                        {t('skills.aiSelectedCount', { count: selectedCount })}
                                      </span>
                                    )}
                                    <ChevronRight className='h-3.5 w-3.5 text-gray-300' />
                                  </button>
                                )
                              })}
                            </>
                          )}

                          {/* Level 2 (database only): select subtype */}
                          {connLevel === 'dbType' && (
                            <>
                              <div className='border-gray-100 border-b px-3 py-2 text-[11px] text-gray-400'>
                                {t('skills.aiSelectDbType')}
                              </div>
                              {Array.from(dbTypeMap.entries()).map(([subType, conns]) => {
                                const icon =
                                  DATABASE_SUBTYPE_ICONS[subType as DatabaseSubtype] ?? '🗄️'
                                const label =
                                  DATABASE_SUBTYPE_LABELS[subType as DatabaseSubtype] ?? subType
                                const count = conns.length
                                const selectedCount = conns.filter((c) =>
                                  selectedConnIds.has(c.id)
                                ).length
                                return (
                                  <button
                                    key={subType}
                                    type='button'
                                    onClick={() => {
                                      setConnSelectedDbType(subType)
                                      setConnLevel('pick')
                                    }}
                                    className='flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors hover:bg-gray-50'
                                  >
                                    <span className='text-base'>{icon}</span>
                                    <span className='flex-1 font-medium text-gray-800'>
                                      {label}
                                    </span>
                                    <span className='text-[11px] text-gray-400'>
                                      {t('skills.aiConnectionCount', { count })}
                                    </span>
                                    {selectedCount > 0 && (
                                      <span className='rounded-full bg-green-100 px-1.5 py-0.5 font-medium text-[10px] text-green-700'>
                                        {t('skills.aiSelectedCount', { count: selectedCount })}
                                      </span>
                                    )}
                                    <ChevronRight className='h-3.5 w-3.5 text-gray-300' />
                                  </button>
                                )
                              })}
                            </>
                          )}

                          {/* Level 3: select specific connection */}
                          {connLevel === 'pick' && (
                            <>
                              <div className='border-gray-100 border-b px-3 py-2 text-[11px] text-gray-400'>
                                {t('skills.aiSelectSpecificConn')}
                              </div>
                              {pickList.length === 0 ? (
                                <div className='px-3 py-4 text-center text-gray-400 text-xs'>
                                  {t('skills.aiNoConnections')}
                                </div>
                              ) : (
                                pickList.map((c) => {
                                  const selected = selectedConnIds.has(c.id)
                                  return (
                                    <button
                                      key={c.id}
                                      type='button'
                                      onClick={() => toggleConn(c.id)}
                                      className={cn(
                                        'flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs transition-colors hover:bg-gray-50',
                                        selected && 'bg-green-50'
                                      )}
                                    >
                                      <div
                                        className={cn(
                                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                          selected
                                            ? 'border-green-500 bg-green-500 text-white'
                                            : 'border-gray-300'
                                        )}
                                      >
                                        {selected && <CheckCircle2 className='h-3 w-3' />}
                                      </div>
                                      <span className='min-w-0 flex-1 truncate font-medium text-gray-800'>
                                        {c.name}
                                      </span>
                                      {c.envVars.length > 0 && (
                                        <span className='text-[10px] text-gray-400'>
                                          {t('skills.aiConnVarCount', { count: c.envVars.length })}
                                        </span>
                                      )}
                                    </button>
                                  )
                                })
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })()}
              </div>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {phase !== 'idle' && (
              <span className='flex items-center gap-1.5 text-gray-400 text-xs'>
                {isWorking && <Loader2 className='h-3 w-3 animate-spin' />}
                {phase === 'generating' && t('skills.aiPhaseGenerating')}
                {phase === 'security-check' && t('skills.aiPhaseSecurity')}
                {phase === 'testing' && t('skills.aiPhaseTesting')}
                {phase === 'validating' && t('skills.aiPhaseValidating')}
                {phase === 'fixing' && t('skills.aiPhaseFixing')}
                {phase === 'done' && t('skills.aiPhaseDone')}
                {phase === 'need-input' && t('skills.aiPhaseNeedInput')}
              </span>
            )}
            <button
              type='button'
              onClick={requestClose}
              className='rounded-lg p-1.5 hover:bg-gray-100'
            >
              <X className='h-4 w-4 text-gray-400' />
            </button>
          </div>
        </div>

        {/* Body — left chat / right tool preview */}
        <div className='flex flex-1 overflow-hidden'>
          {/* Left: Chat area */}
          <div className='flex flex-1 flex-col overflow-hidden'>
            {/* Messages */}
            <div className='relative flex-1 overflow-hidden'>
              <div
                ref={chatScrollRef}
                onScroll={handleChatScroll}
                onWheel={handleWheel}
                className='h-full space-y-4 overflow-y-auto px-6 py-4'
              >
                {messages.length === 0 && (
                  <div className='flex h-full flex-col items-center justify-center text-gray-300'>
                    <Sparkles className='mb-3 h-10 w-10' />
                    <p className='font-medium text-sm'>{t('skills.aiEmptyTitle')}</p>
                    <p className='mt-1 text-xs'>{t('skills.aiEmptyHint')}</p>
                    <p className='mt-0.5 text-xs'>{t('skills.aiEmptyFileHint')}</p>
                  </div>
                )}

                {messages
                  .filter((m) => !m.hidden)
                  .map((rawMsg) => {
                    // Guard: ensure content is always string, prevent React from rendering objects
                    const msg =
                      typeof rawMsg.content === 'string'
                        ? rawMsg
                        : { ...rawMsg, content: safeStr(rawMsg.content) }
                    return (
                      <div
                        key={msg.id}
                        className={cn('flex gap-3', msg.role === 'user' ? 'flex-row-reverse' : '')}
                      >
                        {/* Avatar */}
                        <div
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                            msg.role === 'user' ? 'bg-blue-100' : 'bg-violet-100'
                          )}
                        >
                          {msg.role === 'user' ? (
                            <User className='h-3.5 w-3.5 text-blue-600' />
                          ) : (
                            <Bot className='h-3.5 w-3.5 text-violet-600' />
                          )}
                        </div>

                        {/* Bubble */}
                        <div
                          className={cn(
                            'max-w-[80%] rounded-xl px-4 py-2.5 text-sm',
                            msg.role === 'user'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-800'
                          )}
                        >
                          {/* Phase badge */}
                          {msg.phaseBadge && (
                            <span
                              className={cn(
                                'mb-1.5 inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs',
                                msg.phaseBadge.includes(t('skills.generatorBadgePassedKeyword')) ||
                                  msg.phaseBadge.includes(t('skills.generatorBadgeSuccessKeyword'))
                                  ? 'bg-green-100 text-green-700'
                                  : msg.phaseBadge.includes(
                                        t('skills.generatorBadgeFailedKeyword')
                                      ) ||
                                      msg.phaseBadge.includes(
                                        t('skills.generatorBadgeExceptionKeyword')
                                      )
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-violet-100 text-violet-700'
                              )}
                            >
                              {msg.phaseBadge}
                            </span>
                          )}

                          {/* Files */}
                          {msg.files && msg.files.length > 0 && (
                            <div className='mb-2 flex flex-wrap gap-1'>
                              {msg.files.map((f, i) => (
                                <span
                                  key={i}
                                  className='inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 text-xs'
                                >
                                  <Paperclip className='h-3 w-3' />
                                  {f.name}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Thinking (collapsible, auto-collapsed) */}
                          {msg.thinking && (
                            <div className='mb-2'>
                              <button
                                type='button'
                                onClick={() => toggleThinking(msg.id)}
                                className='flex items-center gap-1 text-gray-400 text-xs hover:text-gray-600'
                              >
                                <span>{t('skills.aiDeepThought')}</span>
                                {msg.thinkingCollapsed ? (
                                  <ChevronDown className='h-3 w-3' />
                                ) : (
                                  <ChevronUp className='h-3 w-3' />
                                )}
                              </button>
                              {!msg.thinkingCollapsed && (
                                <div className='mt-1.5 border-gray-200 border-l-2 pl-3 text-gray-500 text-xs leading-relaxed'>
                                  {renderContent(cleanEscapes(msg.thinking))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Content */}
                          <div className='whitespace-pre-wrap break-words'>
                            {msg.tool
                              ? renderContent(
                                  cleanEscapes(
                                    msg.content.replace(
                                      /```json[\s\S]*?```/g,
                                      t('skills.aiToolCodeGenerated')
                                    )
                                  )
                                )
                              : msg.role === 'assistant'
                                ? renderContent(cleanEscapes(stripThinkTags(msg.content)))
                                : msg.content}
                            {msg.isStreaming && (
                              <span className='ml-1 inline-block h-4 w-1 animate-pulse bg-violet-400' />
                            )}
                          </div>

                          {/* File download */}
                          {msg.fileDownload && (
                            <div className='mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2'>
                              <Download className='h-4 w-4 shrink-0 text-blue-600' />
                              <a
                                href={
                                  msg.fileDownload.downloadUrl ??
                                  createDownloadUrl(
                                    msg.fileDownload.base64 ?? '',
                                    msg.fileDownload.format
                                  )
                                }
                                download={msg.fileDownload.fileName}
                                target={msg.fileDownload.downloadUrl ? '_blank' : undefined}
                                rel={
                                  msg.fileDownload.downloadUrl ? 'noopener noreferrer' : undefined
                                }
                                className='font-medium text-blue-700 text-sm underline hover:text-blue-900'
                                data-testid='chat:link:file-download'
                              >
                                {msg.fileDownload.fileName}
                              </a>
                              {msg.fileDownload.base64 && (
                                <span className='text-blue-500 text-xs'>
                                  ({((msg.fileDownload.base64.length * 0.75) / 1024).toFixed(1)} KB)
                                </span>
                              )}
                              {msg.fileDownload.downloadUrl && (
                                <span className='text-blue-500 text-xs'>
                                  {t('skills.aiFileValidFor7Days')}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Test result badge */}
                          {msg.testResult && (
                            <div
                              className={cn(
                                'mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs',
                                msg.testResult.success
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-red-100 text-red-700'
                              )}
                            >
                              {msg.testResult.success ? (
                                <>
                                  <CheckCircle2 className='h-3 w-3' /> {t('skills.aiTestPassed')}
                                </>
                              ) : (
                                <>
                                  <XCircle className='h-3 w-3' /> {t('skills.aiTestFailed')}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                <div ref={chatEndRef} />
              </div>
              {/* Scroll to bottom floating button */}
              {showScrollBtn && (
                <button
                  type='button'
                  onClick={scrollToBottom}
                  className='-translate-x-1/2 absolute bottom-2 left-1/2 z-10 flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-gray-600 text-xs shadow-lg hover:bg-gray-50'
                >
                  <ArrowDown className='h-3 w-3' />
                  {t('skills.aiScrollToBottom')}
                </button>
              )}
            </div>

            {/* Input area - drag up to resize height */}
            <div className='border-t'>
              {/* Drag handle */}
              <div
                className='group flex h-3 cursor-row-resize items-center justify-center hover:bg-gray-100'
                onMouseDown={(e) => {
                  dragRef.current = { startY: e.clientY, startH: inputHeight }
                  e.preventDefault()
                }}
              >
                <div className='h-0.5 w-10 rounded-full bg-gray-300 transition-colors group-hover:bg-gray-400' />
              </div>
              <div className='flex items-end gap-2 px-6 pb-3'>
                <button
                  type='button'
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isWorking}
                  className='shrink-0 rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50'
                  title={t('skills.aiUploadFileTitle')}
                >
                  <Paperclip className='h-4 w-4' />
                </button>
                <input
                  ref={fileInputRef}
                  type='file'
                  multiple
                  accept='.txt,.md,.csv,.json,.xml,.yaml,.yml,.js,.ts,.py,.doc,.docx,.xls,.xlsx,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.avi,.mp3,.wav'
                  className='hidden'
                  onChange={handleFileSelect}
                />
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      handleSubmit()
                    }
                  }}
                  disabled={isWorking}
                  placeholder={
                    phase === 'need-input'
                      ? t('skills.aiInputPlaceholderNeedInput')
                      : t('skills.aiInputPlaceholderDefault')
                  }
                  style={{ height: inputHeight }}
                  className='flex-1 resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-900 text-sm placeholder:text-gray-400 focus:border-violet-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 disabled:opacity-50'
                  data-testid='dialog:ai-tool-generator:input:message'
                />
                <Button
                  size='sm'
                  onClick={handleSubmit}
                  disabled={!input.trim() || isWorking || !selectedModelId}
                  className='shrink-0 bg-violet-600 hover:bg-violet-700'
                  data-testid='dialog:ai-tool-generator:submit:message'
                >
                  <Send className='h-3.5 w-3.5' />
                </Button>
              </div>
            </div>
          </div>

          {/* Right: Tool preview */}
          <div className='flex w-[360px] shrink-0 flex-col border-l bg-gray-50/50'>
            <div className='flex-1 overflow-y-auto px-5 py-4'>
              {!currentTool ? (
                <div className='flex h-full flex-col items-center justify-center text-gray-300'>
                  <Code2 className='mb-3 h-10 w-10' />
                  <p className='text-sm'>{t('skills.aiToolPreview')}</p>
                  <p className='mt-1 text-xs'>{t('skills.aiToolPreviewHint')}</p>
                </div>
              ) : (
                <div className='space-y-4'>
                  {/* Tool info */}
                  <div>
                    <h3 className='font-semibold text-gray-900 text-sm'>{currentTool.title}</h3>
                    <p className='mt-1 text-gray-500 text-xs'>{currentTool.description}</p>
                  </div>

                  {/* Parameters - editable trial params */}
                  {currentTool.parameters?.properties &&
                    Object.keys(currentTool.parameters.properties).length > 0 && (
                      <div className='space-y-2'>
                        <p className='font-medium text-gray-500 text-xs'>
                          {t('skills.aiParamsEditable')}
                        </p>
                        {Object.entries(currentTool.parameters.properties).map(([key, prop]) => (
                          <div key={key} className='space-y-1'>
                            <div className='flex items-center justify-between'>
                              <label
                                htmlFor={`ai-tool-trial-param-${key}`}
                                className='font-medium text-gray-700 text-xs'
                              >
                                {key}
                              </label>
                              <span className='text-gray-400 text-xs'>{prop.type}</span>
                            </div>
                            <p className='text-gray-400 text-xs'>{prop.description}</p>
                            {prop.type === 'boolean' ? (
                              <select
                                id={`ai-tool-trial-param-${key}`}
                                value={trialParams[key] ?? 'true'}
                                onChange={(e) =>
                                  setTrialParams((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className='w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-violet-400 focus:outline-none'
                                data-testid={`chat:select:trial-param:${key}`}
                              >
                                <option value='true'>true</option>
                                <option value='false'>false</option>
                              </select>
                            ) : (
                              <input
                                id={`ai-tool-trial-param-${key}`}
                                type='text'
                                value={trialParams[key] ?? ''}
                                onChange={(e) =>
                                  setTrialParams((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                placeholder={t('skills.aiInputPlaceholder', { key })}
                                className='w-full rounded-md border border-gray-200 px-2 py-1 text-xs placeholder:text-gray-300 focus:border-violet-400 focus:outline-none'
                                data-testid={`chat:input:trial-param:${key}`}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                  {/* Code */}
                  <details className='group' open>
                    <summary className='flex cursor-pointer items-center gap-1.5 font-medium text-gray-500 text-xs hover:text-gray-700'>
                      <Code2 className='h-3.5 w-3.5' />
                      {t('skills.aiCode')}
                      <ChevronDown className='h-3 w-3 transition-transform group-open:rotate-180' />
                    </summary>
                    <pre className='mt-2 max-h-64 overflow-auto rounded-lg bg-gray-900 p-3 text-gray-100 text-xs'>
                      {currentTool.code}
                    </pre>
                  </details>
                </div>
              )}
            </div>

            {/* Action buttons */}
            {currentTool && (
              <div className='flex items-center justify-end gap-2 border-t bg-white px-5 py-3'>
                {phase === 'done' && (
                  <>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={handleDownload}
                      title={t('skills.aiDownloadPkg')}
                      data-testid='dialog:ai-tool-generator:download'
                    >
                      <Download className='mr-1.5 h-3.5 w-3.5' />
                      {t('skills.aiDownload')}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={handleTrialRun}
                      data-testid='dialog:ai-tool-generator:trial-run'
                    >
                      <Play className='mr-1.5 h-3.5 w-3.5' />
                      {t('skills.aiTrialRun')}
                    </Button>
                    <Button
                      size='sm'
                      className='bg-green-600 hover:bg-green-700'
                      onClick={handleAccept}
                      data-testid='dialog:ai-tool-generator:confirm'
                    >
                      <CheckCircle2 className='mr-1.5 h-3.5 w-3.5' />
                      {t('skills.aiAdoptTool')}
                    </Button>
                  </>
                )}
                {(phase === 'idle' || phase === 'need-input') && (
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={handleAccept}
                    data-testid='dialog:ai-tool-generator:save-directly'
                  >
                    {t('skills.aiDirectSave')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Close confirmation dialog */}
      {showCloseConfirm && (
        <div className='fade-in fixed inset-0 z-[60] flex animate-in items-center justify-center bg-black/40 duration-150'>
          <div className='zoom-in-95 w-[400px] animate-in rounded-xl bg-white p-6 shadow-2xl duration-150'>
            <h3 className='font-semibold text-base text-gray-900'>
              {t('skills.aiCloseConfirmTitle')}
            </h3>
            <p className='mt-2 text-gray-500 text-sm'>{t('skills.aiCloseConfirmDesc')}</p>
            <div className='mt-5 flex justify-end gap-3'>
              <Button variant='outline' size='sm' onClick={() => setShowCloseConfirm(false)}>
                {t('skills.aiCloseConfirmCancel')}
              </Button>
              <Button variant='destructive' size='sm' onClick={handleClose}>
                {t('skills.aiCloseConfirmOk')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File helper
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
