import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { db } from '@crewmeld/db'
import { toolInstances } from '@crewmeld/db/schema'
import { createLogger } from '@crewmeld/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { apiAuthErr, apiErr, apiOk } from '@/lib/api/response'
import { withAudit } from '@/lib/audit/with-audit'
import { requirePermission } from '@/lib/auth/rbac/check-permission'
import { resolveConnectionEnvVars } from '@/lib/connectors/resolve-conn-env'
import {
  buildJsResolvePrelude,
  buildPyResolvePrelude,
  extractParamResolution,
  type ParamResolution,
} from '@/lib/tools/param-resolution'

const logger = createLogger('ToolExecuteAPI')

// Package name validation pattern (npm and pip compatible)
const SAFE_PKG_NAME = /^[@a-z0-9][\w.\-/]*$/i

/** Validate that all package names are safe (no shell injection) */
function validatePackageNames(deps: string[]): void {
  for (const dep of deps) {
    if (!SAFE_PKG_NAME.test(dep)) {
      throw new Error(`Invalid dependency name: ${dep}`)
    }
  }
}

const IS_WINDOWS = process.platform === 'win32'

/**
 * On Windows, npm / pip / python are batch / CMD wrappers (npm.cmd, pip.cmd).
 * Node's `execFile` doesn't auto-resolve those extensions and fails with
 * `spawn npm ENOENT`. Setting `shell: true` lets the system shell resolve the
 * command via PATHEXT. Args are package names already vetted by validatePackageNames.
 */
const WIN_SHELL_OPT: { shell: boolean } | Record<string, never> = IS_WINDOWS
  ? { shell: true }
  : {}

// Whitelisted environment variable keys for child processes
const SAFE_ENV_KEYS = [
  'PATH',
  'NODE_ENV',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'COMSPEC',
] as const

/** Build a safe env object from process.env (only whitelisted keys) */
function buildSafeEnv(): Record<string, string | undefined> {
  const safeEnv: Record<string, string | undefined> = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) safeEnv[key] = process.env[key]
  }
  return safeEnv
}

// SSRF: blocked metadata service hostnames/IPs
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS / GCP metadata
  'metadata.google.internal',
  '100.100.100.200', // Alibaba Cloud metadata
  'metadata.tencentyun.com',
])

/** Validate podEndpoint URL to prevent SSRF */
function validatePodEndpoint(endpoint: string): void {
  const url = new URL(endpoint)
  if (BLOCKED_HOSTS.has(url.hostname)) {
    throw new Error('Invalid pod endpoint: blocked host')
  }
  // Only allow http protocol (K8S internal NodePort)
  if (url.protocol !== 'http:') {
    throw new Error('Invalid pod endpoint: only http is allowed')
  }
  // Must match K8S_NODE_IP if configured
  const allowedIp = process.env.K8S_NODE_IP
  if (allowedIp && url.hostname !== allowedIp) {
    throw new Error('Invalid pod endpoint: hostname does not match K8S_NODE_IP')
  }
}

/**
 * POST /api/employee/tools/execute
 *
 * Execute AI-generated skill code (supports import/require).
 * Simple code runs in a new Function sandbox; code with imports is written to a temp file and executed via node subprocess.
 */
async function _POST(request: NextRequest) {
  try {
    const auth = await requirePermission('skill:edit')
    if (!auth.authenticated || auth.error) {
      return apiAuthErr(auth)
    }

    const body = await request.json()
    const {
      code,
      params = {},
      timeout = 30000,
      envVars = {},
      language = 'javascript',
      podEndpoint,
      instanceId,
      connectionId,
      parameters,
      presetParams,
    } = body as {
      code: string
      params: Record<string, unknown>
      timeout: number
      envVars: Record<string, string>
      language: 'javascript' | 'python'
      podEndpoint?: string
      instanceId?: string
      /** Connection ID passed directly (used during testing, takes priority over instanceId) */
      connectionId?: string
      /** Tool parameter schema (with optional envName per property) for env merging */
      parameters?: { properties?: Record<string, { type?: string; envName?: string }> }
      /** Default values captured at publish time, used as fallback when caller omits them */
      presetParams?: Record<string, string>
    }

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return apiErr('api.tool.codeMissing', { status: 400 })
    }

    // Parse connection config and merge into envVars
    // Priority: explicit connectionId > instanceId-linked connection > request envVars
    let mergedEnvVars = { ...envVars }
    let resolvedConnId = connectionId
    if (!resolvedConnId && instanceId) {
      const [instance] = await db
        .select({ connectionId: toolInstances.connectionId })
        .from(toolInstances)
        .where(eq(toolInstances.id, instanceId))
        .limit(1)
      resolvedConnId = instance?.connectionId ?? undefined
    }
    if (resolvedConnId) {
      const connEnv = await resolveConnectionEnvVars(resolvedConnId)
      mergedEnvVars = { ...connEnv, ...envVars }
    }
    // CONN_* keys present in the merged env (whether sourced from connectionId
    // resolution or already inlined in the request envVars). Used below to
    // backfill envMap for legacy tools that have no envName saved.
    const connEnvKeys = new Set(
      Object.keys(mergedEnvVars).filter((k) => k.startsWith('CONN_'))
    )

    const startTime = Date.now()

    // ---- Pod execution path: execute via K8S Pod (JS + Python) ----
    if (podEndpoint) {
      validatePodEndpoint(podEndpoint)
      const result = await executeInPod(podEndpoint, code, params, language, mergedEnvVars)
      const executionTime = Date.now() - startTime
      logger.info('Skill code executed in Pod successfully', {
        userId: auth.userId!,
        executionTime,
        mode: 'pod',
      })
      return apiOk(null, { extra: { output: { result: result ?? null, executionTime } } })
    }

    // ---- Local execution path (fallback) ----
    const isPython = language === 'python'
    const hasImport = /\bimport\s/.test(code) || /\brequire\s*\(/.test(code)

    let result: unknown
    let mode: string

    const resolution = extractParamResolution(parameters, presetParams)

    // Backfill envMap for legacy tools (saved before envName was populated):
    // when a connection is resolved AND a parameter has no explicit envName but
    // its (aliased) name matches a CONN_* key, synthesize the mapping. This lets
    // existing MySQL tools work after just selecting a connection — no regen needed.
    if (parameters?.properties && connEnvKeys.size > 0) {
      const DB_PARAM_ALIASES: Record<string, string> = {
        user: 'username',
        pwd: 'password',
        db: 'database',
        dbName: 'database',
        databaseName: 'database',
      }
      const camelToConn = (k: string) =>
        `CONN_${k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
      for (const [k, p] of Object.entries(parameters.properties)) {
        if (resolution.envMap[k]) continue
        const canonical = DB_PARAM_ALIASES[k] ?? k
        const candidate = camelToConn(canonical)
        if (connEnvKeys.has(candidate)) {
          resolution.envMap[k] = candidate
          if (p?.type) resolution.types[k] = p.type
        }
      }
    }

    if (isPython) {
      // Python tool: write temp file, execute via python subprocess
      mode = 'python'
      result = await executeAsPython(code, params, mergedEnvVars, timeout, resolution)
    } else if (hasImport) {
      // JS module mode: write temp file, execute via node subprocess
      mode = 'module'
      result = await executeAsModule(code, params, mergedEnvVars, timeout, resolution)
    } else {
      // JS simple mode: new Function sandbox execution
      mode = 'sandbox'
      result = await executeInSandbox(code, params, mergedEnvVars, timeout, resolution)
    }

    const executionTime = Date.now() - startTime
    logger.info('Skill code executed successfully', { userId: auth.userId!, executionTime, mode })

    return apiOk(null, { extra: { output: { result: result ?? null, executionTime } } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Skill code execution failed', { error: msg })
    return apiErr('api.tool.executeFailed', { status: 500, extra: { detail: msg } })
  }
}

// ---------------------------------------------------------------------------
// Simple mode: new Function sandbox
// ---------------------------------------------------------------------------

async function executeInSandbox(
  code: string,
  params: Record<string, unknown>,
  envVars: Record<string, string>,
  timeout: number,
  resolution: ParamResolution
): Promise<unknown> {
  const SAFE_IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u
  for (const key of Object.keys(params)) {
    if (!SAFE_IDENT.test(key)) {
      throw new Error(`Invalid parameter name: ${key}`)
    }
  }
  // Destructure from __merged__ so preset/env values reach the user code even
  // when the caller omits them in `params`. Union of body keys + resolution keys
  // ensures connection-bound params (e.g. host) get a `const host = __merged__.host`
  // line even if the request body only carried `sql`.
  const allKeys = Array.from(
    new Set([
      ...Object.keys(params),
      ...Object.keys(resolution.preset),
      ...Object.keys(resolution.envMap),
    ])
  ).filter((k) => SAFE_IDENT.test(k))

  const paramDestructuring = allKeys
    .map((key) => `const ${key} = __merged__[${JSON.stringify(key)}];`)
    .join('\n')

  const envSetup =
    Object.keys(envVars).length > 0
      ? `const process = { env: __envVars__ };`
      : `const process = { env: {} };`

  const wrappedCode = `
    return (async () => {
      ${envSetup}
      const params = __params__;
${buildJsResolvePrelude(resolution, '      ')}
      ${paramDestructuring}
      ${code}
    })();
  `

  const fn = new Function('__params__', 'fetch', '__envVars__', wrappedCode)

  let timer: ReturnType<typeof setTimeout>
  const result = await Promise.race([
    fn(params, globalThis.fetch, envVars),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Execution timeout (${timeout / 1000}s)`)), timeout)
    }),
  ]).finally(() => clearTimeout(timer!))

  return result
}

// ---------------------------------------------------------------------------
// Module mode: write temp file, execute via node subprocess (supports import/require)
// ---------------------------------------------------------------------------

async function executeAsModule(
  code: string,
  params: Record<string, unknown>,
  envVars: Record<string, string>,
  timeout: number,
  resolution: ParamResolution
): Promise<unknown> {
  // Create temp directory
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewmeld-tool-'))

  try {
    const hasESMImport = /\bimport\s/.test(code)
    const hasRequire = /\brequire\s*\(/.test(code)
    // ESM mode: has import statements; CJS mode: only require
    const isESM = hasESMImport

    // Separate import statements (ESM mode only) from business code
    const lines = code.split('\n')
    const imports: string[] = []
    const body: string[] = []
    for (const line of lines) {
      if (isESM && /^\s*(import\s|import\{)/.test(line)) {
        imports.push(line)
      } else {
        body.push(line)
      }
    }

    // Generate package.json
    const pkgJson = isESM ? { type: 'module' } : {}
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson))

    // Destructure __merged__ (preset + env + body) so connection-bound params
    // reach user code even when the caller only supplies a subset.
    const SAFE_IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u
    const allKeys = Array.from(
      new Set([
        ...Object.keys(params),
        ...Object.keys(resolution.preset),
        ...Object.keys(resolution.envMap),
      ])
    ).filter((k) => SAFE_IDENT.test(k))
    const paramLines = allKeys
      .map((k) => `const ${k} = __merged__[${JSON.stringify(k)}];`)
      .join('\n')

    const scriptLines = [
      ...(isESM ? imports : []),
      '',
      'const __params__ = JSON.parse(process.env.__TOOL_PARAMS__);',
      'const params = __params__;',
      buildJsResolvePrelude(resolution, ''),
      paramLines,
      '',
      '(async () => {',
      '  try {',
      ...body.map((l) => `    ${l}`),
      '  } catch (err) {',
      '    process.stdout.write(JSON.stringify({ __error__: err.message }));',
      '    process.exit(0);',
      '  }',
      '})().then((result) => {',
      '  process.stdout.write(JSON.stringify({ __result__: result ?? null }));',
      '}).catch((err) => {',
      '  process.stdout.write(JSON.stringify({ __error__: err.message }));',
      '});',
    ]

    const scriptFile = isESM ? 'tool.mjs' : 'tool.cjs'
    await fs.writeFile(path.join(tmpDir, scriptFile), scriptLines.join('\n'), 'utf-8')

    // Extract third-party dependencies (import + require)
    const builtins = new Set([
      'fs',
      'path',
      'os',
      'http',
      'https',
      'crypto',
      'url',
      'util',
      'stream',
      'buffer',
      'events',
      'querystring',
      'zlib',
      'child_process',
      'net',
      'tls',
      'dns',
      'readline',
    ])
    const deps = new Set<string>()

    // import ... from 'pkg'
    const importRe = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
      if (!builtins.has(pkg) && !pkg.startsWith('node:')) deps.add(pkg)
    }
    // require('pkg')
    const requireRe = /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g
    while ((m = requireRe.exec(code)) !== null) {
      const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
      if (!builtins.has(pkg) && !pkg.startsWith('node:')) deps.add(pkg)
    }

    if (deps.size > 0) {
      const depsArr = Array.from(deps)
      validatePackageNames(depsArr)
      await new Promise<void>((resolve, reject) => {
        logger.info('Installing test dependencies', { deps: depsArr })
        execFile(
          'npm',
          ['install', '--omit=dev', '--quiet', ...depsArr],
          {
            cwd: tmpDir,
            timeout: Math.min(timeout, 60000),
            ...WIN_SHELL_OPT,
          },
          (err) => {
            if (err) reject(new Error(`Dependency installation failed: ${err.message}`))
            else resolve()
          }
        )
      })
    }

    // Execute script
    // Use process.execPath to prevent Turbopack from misinterpreting literal 'node' and its arguments as module imports
    // Node 18+ has built-in fetch, no need for --experimental-fetch
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [scriptFile],
        {
          cwd: tmpDir,
          timeout,
          env: {
            ...buildSafeEnv(),
            ...envVars,
            __TOOL_PARAMS__: JSON.stringify(params),
          } as unknown as NodeJS.ProcessEnv,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) {
            const errMsg = stderr?.trim() || err.message
            reject(new Error(errMsg))
          } else {
            resolve(stdout)
          }
        }
      )
    })

    // Parse output
    const parsed = JSON.parse(output.trim() || '{}')
    if (parsed.__error__) {
      throw new Error(parsed.__error__)
    }
    return parsed.__result__
  } finally {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Python mode: write temp file, execute via python subprocess (supports pip deps)
// ---------------------------------------------------------------------------

// Python standard library (no pip install needed)
const PY_STDLIB = new Set([
  'abc',
  'argparse',
  'array',
  'ast',
  'asyncio',
  'atexit',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'calendar',
  'cgi',
  'cmd',
  'code',
  'codecs',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'csv',
  'ctypes',
  'dataclasses',
  'datetime',
  'dbm',
  'decimal',
  'difflib',
  'dis',
  'email',
  'encodings',
  'enum',
  'errno',
  'faulthandler',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'imaplib',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'math',
  'mimetypes',
  'mmap',
  'multiprocessing',
  'netrc',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'platform',
  'plistlib',
  'poplib',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'queue',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtplib',
  'socket',
  'socketserver',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'sysconfig',
  'tarfile',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'tty',
  'turtle',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'xml',
  'xmlrpc',
  'zipfile',
  'zipimport',
  'zlib',
  '_thread',
])

async function executeAsPython(
  code: string,
  params: Record<string, unknown>,
  envVars: Record<string, string>,
  timeout: number,
  resolution: ParamResolution
): Promise<unknown> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewmeld-py-'))

  try {
    // Extract third-party dependencies
    const deps = new Set<string>()
    const importRe = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      if (!PY_STDLIB.has(m[1])) deps.add(m[1])
    }

    // pip install third-party deps (prefer python -m pip, compatible with Windows where pip may not be in PATH)
    if (deps.size > 0) {
      const depsArr = Array.from(deps)
      validatePackageNames(depsArr)
      logger.info('Installing Python test dependencies', { deps: depsArr })
      await new Promise<void>((resolve, reject) => {
        const tryPip = (cmds: [string, string[]][]) => {
          if (cmds.length === 0) {
            reject(
              new Error(
                'Python dependency installation failed: pip not available, please ensure Python and pip are installed'
              )
            )
            return
          }
          const [cmd, args] = cmds[0]
          execFile(
            cmd,
            [...args, 'install', '--quiet', ...depsArr],
            {
              cwd: tmpDir,
              timeout: Math.min(timeout, 60000),
              ...WIN_SHELL_OPT,
            },
            (err) => {
              if (err) tryPip(cmds.slice(1))
              else resolve()
            }
          )
        }
        tryPip([
          ['python', ['-m', 'pip']],
          ['python3', ['-m', 'pip']],
          ['pip', []],
          ['pip3', []],
        ])
      })
    }

    // Generate Python script: inject params, execute tool code, output JSON result.
    // Bind from __merged__ (preset + env + body) so connection-bound params reach
    // the user code even when only a subset is supplied in the request body.
    const PY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
    const allKeys = Array.from(
      new Set([
        ...Object.keys(params),
        ...Object.keys(resolution.preset),
        ...Object.keys(resolution.envMap),
      ])
    ).filter((k) => PY_IDENT.test(k))
    const paramLines = allKeys.map((k) => `${k} = __merged__[${JSON.stringify(k)}]`).join('\n')

    const script = [
      'import json, os, sys',
      'from datetime import datetime, date, time as _time',
      '',
      '# JSON serialization fallback: handle non-serializable types like datetime',
      'def __json_default__(obj):',
      '    if isinstance(obj, (datetime, date, _time)):',
      '        return obj.isoformat()',
      '    if isinstance(obj, bytes):',
      '        return obj.decode("utf-8", errors="replace")',
      '    if isinstance(obj, set):',
      '        return list(obj)',
      '    return str(obj)',
      '',
      '__params__ = json.loads(os.environ["__TOOL_PARAMS__"])',
      buildPyResolvePrelude(resolution),
      paramLines,
      '',
      'try:',
      ...code.split('\n').map((l) => `    ${l}`),
      '    print(json.dumps({"__result__": result if "result" in dir() else None}, default=__json_default__, ensure_ascii=False))',
      'except Exception as e:',
      '    print(json.dumps({"__error__": str(e)}, ensure_ascii=False))',
    ].join('\n')

    await fs.writeFile(path.join(tmpDir, 'tool.py'), script)

    // Execute
    const output = await new Promise<string>((resolve, reject) => {
      // Try python, fall back to python3
      const tryRun = (cmd: string) => {
        execFile(
          cmd,
          ['tool.py'],
          {
            cwd: tmpDir,
            timeout,
            env: {
              ...buildSafeEnv(),
              ...envVars,
              PYTHONIOENCODING: 'utf-8',
              PYTHONUNBUFFERED: '1',
              __TOOL_PARAMS__: JSON.stringify(params),
            } as unknown as NodeJS.ProcessEnv,
            maxBuffer: 10 * 1024 * 1024,
            ...WIN_SHELL_OPT,
          },
          (err: Error | null, stdout: string, stderr: string) => {
            if (err && cmd === 'python') {
              tryRun('python3')
            } else if (err) {
              reject(new Error(stderr?.trim() || err.message))
            } else {
              resolve(stdout)
            }
          }
        )
      }
      tryRun('python')
    })

    const parsed = JSON.parse(output.trim() || '{}')
    if (parsed.__error__) {
      throw new Error(parsed.__error__)
    }
    return parsed.__result__
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Pod execution mode: via K8S Pod /_inject + POST /
// ---------------------------------------------------------------------------

async function executeInPod(
  podEndpoint: string,
  code: string,
  params: Record<string, unknown>,
  language: 'javascript' | 'python',
  envVars: Record<string, string> = {}
): Promise<unknown> {
  // Determine injection mode
  let mode: string
  if (language === 'python') {
    mode = 'python'
  } else {
    const hasImport = /\bimport\s/.test(code) || /\brequire\s*\(/.test(code)
    mode = hasImport ? 'module' : 'simple'
  }

  // 1. Extract third-party deps: prefer server-side install and upload, fall back to in-Pod install on failure
  const deps = extractDepsFromCode(code, language)
  if (deps.length > 0) {
    try {
      logger.info('Attempting server-side dependency install and upload to Pod', { deps, language })
      await installDepsAndUpload(podEndpoint, deps, language)
    } catch (uploadErr) {
      logger.warn(
        `Server-side install failed (${(uploadErr as Error).message}), falling back to in-Pod install`
      )
      const depsRes = await podEndpointCall(
        podEndpoint,
        '/_deps',
        'PUT',
        { deps, language },
        180000
      )
      if (!depsRes.ok) {
        const errMsg = depsRes.data?.error ?? 'Dependency installation failed'
        throw new Error(`Dependency installation failed: ${String(errMsg)}`)
      }
    }
  }

  // 2. Inject code into Pod (also pass env vars for secret params)
  const injectTimeout = language === 'python' ? 180000 : 30000
  const injectRes = await podEndpointCall(
    podEndpoint,
    '/_inject',
    'PUT',
    { code, mode, envVars },
    injectTimeout
  )
  if (!injectRes.ok) {
    const errMsg = injectRes.data?.error ?? 'Injection failed'
    throw new Error(`Pod code injection failed: ${String(errMsg)}`)
  }

  // 3. Call Pod to execute
  const execRes = await podEndpointCall(podEndpoint, '/', 'POST', params)
  if (!execRes.ok) {
    const errMsg = execRes.data?.error ?? 'Execution failed'
    throw new Error(`Pod execution failed: ${String(errMsg)}`)
  }

  const data = execRes.data as { success: boolean; result?: unknown; error?: string }
  if (!data.success) {
    throw new Error(data.error ?? 'Pod execution returned failure')
  }

  return data.result
}

/**
 * Install dependencies on the server, package as tar.gz, and upload to Pod.
 * Solves the issue of Pods not having external network access for installing dependencies.
 */
async function installDepsAndUpload(
  podEndpoint: string,
  deps: string[],
  language: 'javascript' | 'python'
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewmeld-deps-'))

  try {
    const isPython = language === 'python'

    validatePackageNames(deps)

    if (isPython) {
      // pip install --target to install packages into specified directory
      await new Promise<void>((resolve, reject) => {
        const tryPip = (cmds: [string, string[]][]) => {
          if (cmds.length === 0) {
            reject(
              new Error(
                'Python dependency installation failed: pip not available, please ensure Python and pip are installed'
              )
            )
            return
          }
          const [cmd, args] = cmds[0]
          execFile(
            cmd,
            [...args, 'install', '--quiet', '--target', tmpDir, ...deps],
            {
              timeout: 120000,
              ...WIN_SHELL_OPT,
            },
            (err) => {
              if (err) tryPip(cmds.slice(1))
              else resolve()
            }
          )
        }
        tryPip([
          ['python', ['-m', 'pip']],
          ['python3', ['-m', 'pip']],
          ['pip', []],
          ['pip3', []],
        ])
      })
    } else {
      // npm install into temp directory
      await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ private: true }))
      await new Promise<void>((resolve, reject) => {
        execFile(
          'npm',
          [
            'install',
            '--omit=dev',
            '--quiet',
            '--registry',
            'https://registry.npmmirror.com',
            ...deps,
          ],
          { cwd: tmpDir, timeout: 120000, ...WIN_SHELL_OPT },
          (err, _stdout, stderr) => {
            if (err)
              reject(new Error(`JS dependency installation failed: ${stderr || err.message}`))
            else resolve()
          }
        )
      })
    }

    // Package as tar.gz (only node_modules or Python packages)
    const tarTarget = isPython ? '.' : 'node_modules'
    const tarball = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        'tar',
        ['czf', '-', '-C', tmpDir, tarTarget],
        {
          maxBuffer: 100 * 1024 * 1024, // 100MB
          encoding: 'buffer' as BufferEncoding,
          ...WIN_SHELL_OPT,
        },
        (err, stdout) => {
          if (err) reject(new Error(`Failed to package dependencies: ${err.message}`))
          else resolve(stdout as unknown as Buffer)
        }
      )
    })

    logger.info(`Dependencies packaged: ${(tarball.length / 1024).toFixed(0)}KB`, {
      deps,
      language,
    })

    // Upload to Pod
    const uploadRes = await podEndpointCall(
      podEndpoint,
      '/_upload-modules',
      'PUT',
      { tarball: tarball.toString('base64'), language },
      60000
    )
    if (!uploadRes.ok) {
      throw new Error(
        `Failed to upload dependencies to Pod: ${uploadRes.data?.error ?? 'Unknown error'}`
      )
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Node.js built-in modules
const JS_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'http',
  'https',
  'crypto',
  'url',
  'util',
  'stream',
  'buffer',
  'events',
  'querystring',
  'zlib',
  'child_process',
  'net',
  'tls',
  'dns',
  'readline',
  'assert',
  'cluster',
  'dgram',
  'domain',
  'inspector',
  'perf_hooks',
  'string_decoder',
  'timers',
  'tty',
  'v8',
  'vm',
  'worker_threads',
])

/** Extract third-party dependencies that need installation from code */
function extractDepsFromCode(code: string, language: 'javascript' | 'python'): string[] {
  const deps = new Set<string>()

  if (language === 'python') {
    // Python: import xxx / from xxx import ...
    const pyImportRe = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = pyImportRe.exec(code)) !== null) {
      const pkg = m[1]
      if (!PY_STDLIB.has(pkg)) {
        // Common pip package name mapping (import name -> pip package name)
        deps.add(PY_IMPORT_TO_PIP[pkg] ?? pkg)
      }
    }
  } else {
    // JS: import ... from 'pkg' / require('pkg')
    const importRe = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
      if (!JS_BUILTINS.has(pkg) && !pkg.startsWith('node:')) deps.add(pkg)
    }
    const requireRe = /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g
    while ((m = requireRe.exec(code)) !== null) {
      const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
      if (!JS_BUILTINS.has(pkg) && !pkg.startsWith('node:')) deps.add(pkg)
    }
  }

  return Array.from(deps)
}

/** Python import name to pip package name mapping (only list inconsistent ones) */
const PY_IMPORT_TO_PIP: Record<string, string> = {
  mysql: 'mysql-connector-python',
  cv2: 'opencv-python',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  yaml: 'PyYAML',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  docx: 'python-docx',
  pptx: 'python-pptx',
  gi: 'PyGObject',
  attr: 'attrs',
  serial: 'pyserial',
  usb: 'pyusb',
  wx: 'wxPython',
  Crypto: 'pycryptodome',
}

/** Call Pod HTTP endpoint via NodePort */
function podEndpointCall(
  endpoint: string,
  urlPath: string,
  method: string,
  body?: unknown,
  timeoutMs = 30000
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined
    const req = http.request(
      `${endpoint}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
            resolve({ ok: (res.statusCode ?? 500) < 300, data })
          } catch {
            resolve({ ok: false, data: { error: 'Parse error' } })
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Pod invocation timeout'))
    })
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

export const POST = withAudit(_POST)
