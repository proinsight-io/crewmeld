import { execFile } from 'child_process'
import { promises as fs } from 'fs'
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
import { isJobModeAvailable, runToolJob } from '@/lib/k8s/job-runner'
import { getSandboxSettings } from '@/lib/sandbox/settings'
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

/**
 * Execution mode selection:
 *   - 'job'   K8s Job per call (default when K8s configured) — isolated, ephemeral
 *   - 'local' Local subprocess / sandbox — used when K8s is unavailable
 * Operator-facing override: K8S_TOOL_EXEC_MODE=job|local.
 */
type ExecMode = 'job' | 'local'

function resolveExecMode(): ExecMode {
  const override = process.env.K8S_TOOL_EXEC_MODE?.toLowerCase()
  if (override === 'local') return 'local'
  if (override === 'job' && isJobModeAvailable()) return 'job'
  return isJobModeAvailable() ? 'job' : 'local'
}

/**
 * POST /api/employee/tools/execute
 *
 * Execute AI-generated skill code. When K8s is configured the call runs as a
 * one-shot Job (isolated Pod, GC'd after completion); otherwise it falls back
 * to a local subprocess or in-process sandbox.
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
    const connEnvKeys = new Set(
      Object.keys(mergedEnvVars).filter((k) => k.startsWith('CONN_'))
    )

    const resolution = extractParamResolution(parameters, presetParams)

    // Backfill envMap for legacy tools (saved before envName was populated):
    // when a connection is resolved AND a parameter has no explicit envName but
    // its (aliased) name matches a CONN_* key, synthesize the mapping.
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

    const startTime = Date.now()
    const mode = resolveExecMode()
    const sandbox = await getSandboxSettings()

    // Local subprocess paths have NO mechanism to enforce a network allowlist
    // (no NetworkPolicy, no kernel-level firewalling per-process). Letting the
    // call proceed would silently produce traffic the operator believed was
    // blocked — refuse instead so the misconfiguration is visible immediately.
    if (mode === 'local' && sandbox.egressMode === 'allowlist') {
      logger.warn(
        'Refused tool execution: egress allowlist set but K8s job mode unavailable',
        { userId: auth.userId! }
      )
      return apiErr('api.tool.allowlistRequiresK8s', { status: 400 })
    }

    let result: unknown
    let pathLabel: string
    let policyApplied = false
    let policyCidrs: string[] = []
    let unresolvedDomains: string[] = []

    if (mode === 'job') {
      pathLabel = 'job'
      try {
        const outcome = await runToolJob({
          code,
          params,
          envVars: mergedEnvVars,
          language,
          timeout,
          resolution,
        })
        result = outcome.result
        policyApplied = outcome.policyApplied
        policyCidrs = outcome.cidrs
        unresolvedDomains = outcome.unresolvedDomains
      } catch (jobErr) {
        // Surface as a tool-level failure so the caller's normal error path applies.
        const msg = jobErr instanceof Error ? jobErr.message : String(jobErr)
        logger.error('Job-mode execution failed', { userId: auth.userId!, error: msg })
        return apiErr('api.tool.executeFailed', { status: 500, extra: { detail: msg } })
      }
    } else {
      // ---- Local execution path ----
      const isPython = language === 'python'
      const hasImport = /\bimport\s/.test(code) || /\brequire\s*\(/.test(code)

      if (isPython) {
        pathLabel = 'python'
        result = await executeAsPython(code, params, mergedEnvVars, timeout, resolution)
      } else if (hasImport) {
        pathLabel = 'module'
        result = await executeAsModule(code, params, mergedEnvVars, timeout, resolution)
      } else {
        pathLabel = 'sandbox'
        result = await executeInSandbox(code, params, mergedEnvVars, timeout, resolution)
      }
    }

    const executionTime = Date.now() - startTime
    logger.info('Skill code executed successfully', {
      userId: auth.userId!,
      executionTime,
      mode: pathLabel,
      egressMode: sandbox.egressMode,
      policyApplied,
      policyCidrCount: policyCidrs.length,
      unresolvedDomainCount: unresolvedDomains.length,
      ...(unresolvedDomains.length > 0 ? { unresolvedDomains } : {}),
    })

    return apiOk(null, {
      extra: {
        output: {
          result: result ?? null,
          executionTime,
          mode: pathLabel,
          egressMode: sandbox.egressMode,
          policyApplied,
          // Empty when nothing failed; non-empty signals the operator that
          // these allowlist domains silently dropped off the policy and the
          // running tool will get blocked when it talks to them.
          unresolvedDomains,
        },
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('Skill code execution failed', { error: msg })
    return apiErr('api.tool.executeFailed', { status: 500, extra: { detail: msg } })
  }
}

// ---------------------------------------------------------------------------
// Local: new Function sandbox
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
// Local: temp file + node subprocess (supports import/require)
// ---------------------------------------------------------------------------

async function executeAsModule(
  code: string,
  params: Record<string, unknown>,
  envVars: Record<string, string>,
  timeout: number,
  resolution: ParamResolution
): Promise<unknown> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewmeld-tool-'))

  try {
    const hasESMImport = /\bimport\s/.test(code)
    const isESM = hasESMImport

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

    const pkgJson = isESM ? { type: 'module' } : {}
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson))

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

    const builtins = new Set([
      'fs', 'path', 'os', 'http', 'https', 'crypto', 'url', 'util', 'stream',
      'buffer', 'events', 'querystring', 'zlib', 'child_process', 'net', 'tls',
      'dns', 'readline',
    ])
    const deps = new Set<string>()

    const importRe = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
      if (!builtins.has(pkg) && !pkg.startsWith('node:')) deps.add(pkg)
    }
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
// Local: python subprocess (supports pip deps)
// ---------------------------------------------------------------------------

const PY_STDLIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'binascii',
  'bisect', 'builtins', 'calendar', 'cgi', 'cmd', 'code', 'codecs', 'collections',
  'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars',
  'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
  'dis', 'email', 'encodings', 'enum', 'errno', 'faulthandler', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext',
  'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'imaplib', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale',
  'logging', 'lzma', 'mailbox', 'math', 'mimetypes', 'mmap', 'multiprocessing', 'netrc',
  'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle', 'platform', 'plistlib',
  'poplib', 'posixpath', 'pprint', 'profile', 'pstats', 'queue', 'random', 're',
  'readline', 'reprlib', 'resource', 'runpy', 'sched', 'secrets', 'select', 'selectors',
  'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib', 'socket', 'socketserver',
  'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'struct', 'subprocess', 'sys',
  'sysconfig', 'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'timeit',
  'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc',
  'tty', 'turtle', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid',
  'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'xml', 'xmlrpc', 'zipfile',
  'zipimport', 'zlib', '_thread',
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
    const deps = new Set<string>()
    const importRe = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = importRe.exec(code)) !== null) {
      if (!PY_STDLIB.has(m[1])) deps.add(m[1])
    }

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

    const output = await new Promise<string>((resolve, reject) => {
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

export const POST = withAudit(_POST)
