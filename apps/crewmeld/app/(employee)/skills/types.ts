export interface ToolParameters {
  type: string
  properties: Record<
    string,
    {
      type: string
      description: string
      secret?: boolean
      /**
       * Env-var name from which the deployed pod fills this param when the
       * caller omits it (e.g. `host` → `CONN_HOST`, `password` → `CREWMELD_PASSWORD`).
       * Resolution order at runtime: request body > env (via this name) > presetParams.
       */
      envName?: string
    }
  >
  required?: string[]
}

export type DeployStatus = 'not_deployed' | 'deploying' | 'deployed' | 'failed'

export interface DeployInfo {
  status: DeployStatus
  /** Access endpoint after deployment, e.g. http://<node-ip>:<node-port> */
  endpoint?: string
  /** Deployment time */
  deployedAt?: string
  /** NodePort assigned by K8S */
  nodePort?: number
  /** Error message on deployment failure */
  errorMessage?: string
  /** OpenSandbox container ID (only for .cmtool deployments) */
  sandboxId?: string
  /** Deployment backend */
  deployType?: 'k8s' | 'opensandbox' | 'opensandbox-script'
  /** Whether the endpoint goes through OpenSandbox proxy (needs OPEN-SANDBOX-API-KEY header) */
  useProxy?: boolean
}

export type SkillLanguage = 'javascript' | 'python'

/** Inline API-tool spec stored as JSON in tools.api_spec. */
export interface ApiToolSpecInline {
  /** JS source snippet: handler(input, ctx). Must `return`. */
  pre: string
  /** Primary HTTP call config. */
  request: {
    /** Default custom_api connection id. */
    connectionId: string
  }
  /** JS source snippet: handler(response, ctx). Must `return`. */
  post: string
}

export interface SkillPackage {
  id: string
  name: string
  description: string
  version: string
  size: string
  uploadedAt: string
  source: 'installed' | 'official' | 'custom' | 'dev-studio'
  category?: string
  author?: string
  url?: string
  /** Parameter schema for AI-generated tools */
  parameters?: ToolParameters
  /** Code for AI-generated tools */
  code?: string
  /** Preset parameter values */
  presetParams?: Record<string, string>
  /** Code language, defaults to javascript */
  language?: SkillLanguage
  /** K8S deployment info */
  deploy?: DeployInfo
  /** Env var config (secret params), injected into Pod on deployment */
  envVars?: Array<{ name: string; value: string }>
  /** API doc (Markdown), describes non-secret param names, types, required status, examples for SOP LLM */
  apiDoc?: string
  /** System connection type required by the tool (only matching connections allowed when creating instances) */
  connectorType?: string | { type: string; dbType?: string }
  /** System connection ID for the instance (instance-level, auto-injected at runtime) */
  connectionId?: string | null
  /**
   * When true, this tool reads/writes files via a per-SOP-execution MinIO
   * workspace mount (`/workspace/inputs`, `/workspace/outputs`). Tools with
   * this flag bypass the warm pool and deploy a fresh Pod per execution so
   * the rclone sidecar can scope the mount to that execution.
   */
  needsFileMount?: boolean
  /**
   * For dev-studio tools: the tool template id (tools.id). Code lives on NFS
   * under paths.toolCode.forBff(templateId). When deploying an instance, `id`
   * is the instance id (used for sandbox/deployment naming) and `templateId`
   * is the source-of-truth for code lookup. Inline-code tools don't set this.
   */
  templateId?: string
  /** SHA-256 hex digest of the workspace code (dev-studio content fingerprint) */
  packageSha256?: string
  /**
   * Tool execution kind.
   * - 'script': container-based execution (default for legacy tools)
   * - 'api': in-process JS sandbox with pre/request/post stages
   */
  kind?: 'script' | 'api'
  /** API-tool spec (only when kind='api'). */
  apiSpec?: ApiToolSpecInline
  /**
   * When true, the platform forwards the resolved caller identity into this
   * tool's request (api: body.identity / X-Identity header; service/script:
   * body.identity). Sourced from the tool record, never from LLM output.
   * Fail-closed when declared but identity is unresolved. Default false.
   */
  forwardIdentity?: boolean
}

/** Connection env var name prefix */
export const CONN_ENV_PREFIX = 'CONN_'

/** Env var prefix for tool secret params (for new tools) */
export const SKILL_ENV_PREFIX = 'CREWMELD_'

/** Convert config key to connection env var: host -> CONN_HOST */
export function configKeyToEnvName(key: string): string {
  return `${CONN_ENV_PREFIX}${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/** Convert secret param name to env var with CREWMELD_ prefix: apiKey -> CREWMELD_API_KEY */
export function skillEnvName(key: string): string {
  return `${SKILL_ENV_PREFIX}${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/** Project context parsed during import, passed to AI tool generator */
export interface GitHubProjectContext {
  /** Project name (inferred from package.json / pyproject.toml / directory name) */
  projectName: string
  /** Detected language */
  language: SkillLanguage
  /** Import source identifier */
  source?: 'github-zip' | 'markdown' | 'skill-zip'
  /** Original code from skill zip import */
  originalCode?: string
  /** Original param schema from skill zip import */
  originalParameters?: Record<string, unknown>
  /** README summary (first 3000 characters) */
  readme?: string
  /** Dependency declaration file content (pyproject.toml / package.json / requirements.txt) */
  depsFile?: string
  /** Dependency declaration filename */
  depsFileName?: string
  /** Example code snippets (files under examples/) */
  examples?: Array<{ name: string; content: string }>
  /** Package entry point content (__init__.py / index.js) */
  entryPoint?: string
  /** Package entry point filename */
  entryPointName?: string
}

/** Tool instance - each template can create multiple instances, independently deployed with own params */
export interface ToolInstance {
  id: string
  templateId: string
  name: string
  /** Associated system connection ID */
  connectionId?: string | null
  /** Associated system connection name (populated on query) */
  connectionName?: string | null
  /** Instance-specific preset params */
  presetParams?: Record<string, string>
  /** Instance-specific env vars */
  envVars?: Array<{ name: string; value: string }>
  /** Instance-specific deploy info */
  deploy?: DeployInfo
  /** Whether this instance is published as an external API */
  publishedAsApi?: boolean
  createdAt: string
  updatedAt: string
}
