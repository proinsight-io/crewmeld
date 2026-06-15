/**
 * K8s Job-mode tool execution.
 *
 * Each call creates a one-shot Job whose Pod executes the user code, prints a
 * delimited result line, and exits. The Job is GC'd via TTLAfterFinished and
 * an explicit DELETE on the success path.
 *
 * Replaces the warm-pool + persistent Pod pattern previously used for ad-hoc
 * test/chat tool invocations. The warm pool is still used for long-running
 * deployed skills (deploy-skill.ts) where throughput beats isolation.
 */

import http from 'http'
import https from 'https'
import { randomBytes } from 'crypto'
import { createLogger } from '@crewmeld/logger'
import {
  applyNetworkPolicy,
  buildAllowlistCidrs,
  buildSandboxNetworkPolicy,
  deleteNetworkPolicy,
  getKubeDnsClusterIp,
} from '@/lib/sandbox/network-policy'
import { getSandboxSettings, type SandboxSettings } from '@/lib/sandbox/settings'
import {
  buildJsResolvePrelude,
  buildPyResolvePrelude,
  type ParamResolution,
} from '@/lib/tools/param-resolution'

const logger = createLogger('K8sJobRunner')

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ''
const K8S_API_TOKEN = process.env.K8S_API_TOKEN ?? ''
const K8S_NAMESPACE = process.env.K8S_DEPLOY_NAMESPACE ?? 'crewmeld-skills'
const K8S_SKIP_TLS = process.env.K8S_SKIP_TLS_VERIFY === 'true'

const JOB_NODE_IMAGE =
  process.env.K8S_IMAGE_NODE ?? 'docker.io/library/node:22-bookworm'
const JOB_PY_IMAGE =
  process.env.K8S_IMAGE_PYTHON ?? 'docker.io/library/python:3.12-bookworm'

/** Marker used to extract the result line from interleaved Pod logs. */
const RESULT_BEGIN = '<<<CREWMELD_TOOL_RESULT_BEGIN>>>'
const RESULT_END = '<<<CREWMELD_TOOL_RESULT_END>>>'

const POLL_INTERVAL_MS = 500
const POLL_BUFFER_MS = 5000

/** True when K8s API credentials are configured. */
export function isJobModeAvailable(): boolean {
  return Boolean(K8S_API_SERVER && K8S_API_TOKEN)
}

// ---------------------------------------------------------------------------
// K8s API helper
// ---------------------------------------------------------------------------

interface K8sResponse {
  ok: boolean
  status: number
  json: () => Promise<Record<string, unknown>>
  text: () => Promise<string>
}

function k8sApi(
  urlPath: string,
  opts: { method: string; body?: unknown; accept?: string }
): Promise<K8sResponse> {
  const url = new URL(urlPath, K8S_API_SERVER)
  const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${K8S_API_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: opts.accept ?? 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        ...(K8S_SKIP_TLS && isHttps ? { rejectUnauthorized: false } : {}),
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          const status = res.statusCode ?? 500
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(JSON.parse(raw)),
            text: () => Promise.resolve(raw),
          })
        })
      }
    )
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunToolJobOpts {
  code: string
  params: Record<string, unknown>
  envVars: Record<string, string>
  language: 'javascript' | 'python'
  /** Wall-clock timeout in ms; also seeds Job.activeDeadlineSeconds. */
  timeout: number
  resolution: ParamResolution
}

export interface RunToolJobResult {
  /** Parsed tool return value (from the marker line). */
  result: unknown
  /**
   * True when an egress NetworkPolicy was successfully applied for this Job's
   * Pod. False means egress is unrestricted — either because sandbox is in
   * 'unrestricted' mode or because allowlist build had no work to do.
   */
  policyApplied: boolean
  /**
   * CIDRs included in the allowlist when policyApplied=true. Useful for
   * surfacing to callers / logs so operators can confirm enforcement scope.
   * Empty array when policyApplied=false.
   */
  cidrs: string[]
  /**
   * Domains the operator configured (or auto-injected bootstrap mirrors) that
   * could not be DNS-resolved — even after public-DNS fallback. When non-empty
   * the corresponding CIDRs are missing from the allowlist, so user code that
   * tries to reach these hosts will be blocked. Callers should surface this
   * to the UI so operators see the silent shortfall.
   */
  unresolvedDomains: string[]
}

/**
 * Execute one tool invocation as a K8s Job. Resolves with the tool's result
 * (parsed from the marker line) or throws with the tool's error message.
 */
export async function runToolJob(opts: RunToolJobOpts): Promise<RunToolJobResult> {
  const jobName = `tool-job-${randomBytes(6).toString('hex')}`
  const isPython = opts.language === 'python'
  const image = isPython ? JOB_PY_IMAGE : JOB_NODE_IMAGE

  const sandbox = await getSandboxSettings()

  const { entryScript, fileExt } = isPython
    ? { entryScript: buildPythonEntry(opts.code, opts.resolution), fileExt: 'py' }
    : buildJsEntryWithExt(opts.code, opts.resolution)

  // Preset packages are Python-only; non-Python tools declare their own deps.
  const presetDeps = isPython ? sandbox.presetPythonPackages : []
  const deps = extractDeps(opts.code, opts.language, presetDeps)

  const bootstrap = buildBootstrap({ isPython, fileExt })

  const containerEnv: Array<{ name: string; value: string }> = [
    { name: 'TOOL_ENTRY_B64', value: Buffer.from(entryScript).toString('base64') },
    { name: 'TOOL_PARAMS_B64', value: Buffer.from(JSON.stringify(opts.params)).toString('base64') },
    { name: 'TOOL_DEPS', value: deps.join(' ') },
    { name: 'TOOL_PRESET_DEPS', value: presetDeps.join(' ') },
    { name: 'TOOL_LANG', value: isPython ? 'python' : 'javascript' },
    { name: 'TOOL_EXT', value: fileExt },
    { name: 'RESULT_BEGIN', value: RESULT_BEGIN },
    { name: 'RESULT_END', value: RESULT_END },
    // Force Python stdout into unbuffered, utf-8 mode so the result marker
    // reaches kubelet's log capture even on abrupt exits. The local execute
    // path sets the same vars; the Job path was missing them.
    { name: 'PYTHONUNBUFFERED', value: '1' },
    { name: 'PYTHONIOENCODING', value: 'utf-8' },
    { name: 'MINIO_ENDPOINT', value: process.env.MINIO_ENDPOINT ?? '' },
    { name: 'MINIO_ACCESS_KEY', value: process.env.MINIO_ACCESS_KEY ?? '' },
    { name: 'MINIO_SECRET_KEY', value: process.env.MINIO_SECRET_KEY ?? '' },
    { name: 'MINIO_BUCKET', value: process.env.MINIO_BUCKET ?? 'tool-files' },
    { name: 'MINIO_PUBLIC_URL', value: process.env.MINIO_PUBLIC_URL ?? '' },
    ...Object.entries(opts.envVars).map(([name, value]) => ({ name, value: String(value ?? '') })),
  ]

  const jobSpec = buildJobSpec({
    name: jobName,
    image,
    bootstrap,
    env: containerEnv,
    timeoutMs: opts.timeout,
    isPython,
  })

  // NetworkPolicy must be created BEFORE the Job so the Pod sees enforcement
  // from its first packet. Created only in allowlist mode.
  const policy = await maybeApplyEgressPolicy(jobName, sandbox)

  const createRes = await k8sApi(`/apis/batch/v1/namespaces/${K8S_NAMESPACE}/jobs`, {
    method: 'POST',
    body: jobSpec,
  })
  if (!createRes.ok) {
    if (policy.applied) {
      void deleteNetworkPolicy(jobName).catch(() => {})
    }
    const body = await createRes.text()
    throw new Error(`Failed to create job: ${body.slice(0, 500)}`)
  }
  logger.info(`Job created: ${jobName} (egressPolicy=${policy.applied ? 'allowlist' : 'unrestricted'})`)

  try {
    const finalStatus = await pollJob(jobName, opts.timeout + POLL_BUFFER_MS)
    const podName = await findJobPod(jobName)
    const logs = podName
      ? await readPodLogWithRetry(podName, jobName, finalStatus.succeeded)
      : ''
    const result = await parseToolOutput(logs, finalStatus, jobName, podName)
    return {
      result,
      policyApplied: policy.applied,
      cidrs: policy.cidrs,
      unresolvedDomains: policy.unresolved,
    }
  } finally {
    // Explicit cleanup; ttlSecondsAfterFinished is the safety net for the Job
    // but NetworkPolicy has no TTL so we must always delete it.
    void deleteJob(jobName).catch((err) =>
      logger.warn(
        `Failed to delete job ${jobName}: ${err instanceof Error ? err.message : String(err)}`
      )
    )
    if (policy.applied) {
      void deleteNetworkPolicy(jobName).catch((err) =>
        logger.warn(
          `Failed to delete NetworkPolicy for ${jobName}: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    }
  }
}

interface PolicyOutcome {
  applied: boolean
  /** CIDRs put into the policy, or [] when applied=false. */
  cidrs: string[]
  /** Domains that failed DNS resolution and are NOT in the allowlist. */
  unresolved: string[]
}

/**
 * Create the egress NetworkPolicy if sandbox is in allowlist mode.
 * Returns the applied CIDRs so the caller can surface them for diagnostics;
 * returns applied=false when sandbox is in 'unrestricted' mode.
 */
async function maybeApplyEgressPolicy(
  jobName: string,
  sandbox: SandboxSettings
): Promise<PolicyOutcome> {
  if (sandbox.egressMode !== 'allowlist') return { applied: false, cidrs: [], unresolved: [] }

  // Run the two lookups in parallel — cidrs depends on user input, kube-dns
  // ClusterIP is a cluster constant (cached after first success). Failing to
  // resolve the ClusterIP is non-fatal: the podSelector DNS rule alone covers
  // any CNI that applies NetworkPolicy after kube-proxy DNAT.
  const [{ cidrs, unresolved }, kubeDnsClusterIp] = await Promise.all([
    buildAllowlistCidrs({
      allowedIps: sandbox.allowedIps,
      allowedDomains: sandbox.allowedDomains,
    }),
    getKubeDnsClusterIp().catch(() => null),
  ])
  if (unresolved.length > 0) {
    logger.warn(`Egress allowlist: unresolved domains for job ${jobName}: ${unresolved.join(', ')}`)
  }
  const spec = buildSandboxNetworkPolicy({ jobName, cidrs, kubeDnsClusterIp })

  try {
    await applyNetworkPolicy(spec)
    // Log the full CIDR list (or a preview when very large) so operators can
    // confirm in stdout exactly which destinations the Pod is allowed to
    // reach — the most common past failure mode was "policy created but
    // wrong scope" and a count alone hid that.
    const previewLimit = 32
    const cidrPreview =
      cidrs.length <= previewLimit
        ? cidrs.join(', ')
        : `${cidrs.slice(0, previewLimit).join(', ')}, …(+${cidrs.length - previewLimit} more)`
    logger.info(
      `NetworkPolicy applied for ${jobName} (${cidrs.length} CIDR${cidrs.length === 1 ? '' : 's'}): ${cidrPreview}`
    )
    return { applied: true, cidrs, unresolved }
  } catch (err) {
    logger.error(
      `Failed to apply NetworkPolicy for ${jobName}: ${err instanceof Error ? err.message : String(err)}`
    )
    // Surface as a job-level error so the user sees why the call failed
    // instead of silently letting the Pod talk to anything.
    throw new Error(
      `Egress allowlist enabled but NetworkPolicy creation failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// ---------------------------------------------------------------------------
// Entry script builders
// ---------------------------------------------------------------------------

function buildJsEntryWithExt(
  code: string,
  resolution: ParamResolution
): { entryScript: string; fileExt: 'mjs' | 'cjs' } {
  const hasESMImport = /\bimport\s/.test(code)
  const hasRequire = /\brequire\s*\(/.test(code)
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

  const SAFE_IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u
  // Param destructuring keys come only from preset/envMap because runtime
  // params arrive via env, not at build time. The prelude exposes `__merged__`.
  const allKeys = Array.from(
    new Set([...Object.keys(resolution.preset), ...Object.keys(resolution.envMap)])
  ).filter((k) => SAFE_IDENT.test(k))
  const paramLines = allKeys
    .map((k) => `const ${k} = __merged__[${JSON.stringify(k)}];`)
    .join('\n')

  // File extension drives module mode — and therefore which fs-import syntax
  // we must emit. Default to .mjs (top-level await friendly) unless the user
  // explicitly used CommonJS `require()`. Deriving `fsImport` from `fileExt`
  // (not `isESM`) avoids the .mjs-with-require trap when user code has
  // neither `import` nor `require` statements.
  const fileExt: 'mjs' | 'cjs' = isESM ? 'mjs' : hasRequire ? 'cjs' : 'mjs'
  const useESMSyntax = fileExt === 'mjs'

  // fs.writeSync to fd 1 bypasses Node's stream buffer, so the marker reaches
  // kubelet even when the process is torn down before stdout would drain
  // (which is exactly what `process.exit()` after `process.stdout.write()`
  // used to cause on the container's stdout pipe).
  const fsImport = useESMSyntax
    ? "import { writeSync as __fsWriteSync__ } from 'node:fs';"
    : "const { writeSync: __fsWriteSync__ } = require('node:fs');"

  const scriptLines = [
    ...(useESMSyntax ? [fsImport, ...imports] : []),
    '',
    ...(useESMSyntax ? [] : [fsImport]),
    // Marker plumbing — registered before user code so it covers user-side
    // process.exit() (via 'exit'), uncaught throws, and unhandled rejections.
    // The flag prevents the success and error paths from both writing when
    // user code throws *and* then process exits normally.
    'let __markerWritten__ = false;',
    'const __writeMarker__ = (payload) => {',
    '  if (__markerWritten__) return;',
    '  __markerWritten__ = true;',
    '  const __line__ = "\\n" + process.env.RESULT_BEGIN + JSON.stringify(payload) + process.env.RESULT_END + "\\n";',
    '  try { __fsWriteSync__(1, __line__); } catch (e) { try { process.stdout.write(__line__); } catch (e2) {} }',
    '};',
    "process.on('exit', () => __writeMarker__({ __result__: null }));",
    "process.on('uncaughtException', (err) => __writeMarker__({ __error__: String((err && err.message) || err || 'uncaughtException') }));",
    "process.on('unhandledRejection', (err) => __writeMarker__({ __error__: String((err && err.message) || err || 'unhandledRejection') }));",
    '',
    'const __params__ = JSON.parse(process.env.__TOOL_PARAMS__ || "{}");',
    'const params = __params__;',
    buildJsResolvePrelude(resolution, ''),
    paramLines,
    // Destructure any keys the user passed via params that weren't in preset/envMap
    'for (const __k__ of Object.keys(__params__)) {',
    '  if (typeof globalThis[__k__] === "undefined") globalThis[__k__] = __merged__[__k__];',
    '}',
    '',
    '(async () => {',
    ...body.map((l) => `  ${l}`),
    '})().then((result) => {',
    '  __writeMarker__({ __result__: result ?? null });',
    '}).catch((err) => {',
    '  __writeMarker__({ __error__: String((err && err.message) || err) });',
    '});',
  ]

  return { entryScript: scriptLines.join('\n'), fileExt }
}

function buildPythonEntry(code: string, resolution: ParamResolution): string {
  const PY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
  const allKeys = Array.from(
    new Set([...Object.keys(resolution.preset), ...Object.keys(resolution.envMap)])
  ).filter((k) => PY_IDENT.test(k))
  const paramLines = allKeys.map((k) => `${k} = __merged__[${JSON.stringify(k)}]`).join('\n')

  return [
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
    '__params__ = json.loads(os.environ.get("__TOOL_PARAMS__", "{}"))',
    buildPyResolvePrelude(resolution),
    paramLines,
    // Backfill any body-only params not in preset/envMap
    'for __k__, __v__ in __params__.items():',
    '    if __k__ not in dir():',
    '        globals()[__k__] = __merged__.get(__k__)',
    '',
    '__BEGIN__ = os.environ["RESULT_BEGIN"]',
    '__END__ = os.environ["RESULT_END"]',
    // BaseException (not Exception) so SystemExit / KeyboardInterrupt also
    // yield a marker. Without this, `sys.exit()` / `exit()` in user code
    // produces a zero-exit pod with no result, which the caller can only
    // report as "produced no result marker".
    'try:',
    ...code.split('\n').map((l) => `    ${l}`),
    '    sys.stdout.write("\\n" + __BEGIN__ + json.dumps({"__result__": result if "result" in dir() else None}, default=__json_default__, ensure_ascii=False) + __END__ + "\\n")',
    'except BaseException as e:',
    '    sys.stdout.write("\\n" + __BEGIN__ + json.dumps({"__error__": str(e) or type(e).__name__}, ensure_ascii=False) + __END__ + "\\n")',
    'finally:',
    '    try: sys.stdout.flush()',
    '    except Exception: pass',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Bootstrap shell script (decodes entry, installs deps from cache, runs)
// ---------------------------------------------------------------------------

function buildBootstrap(opts: { isPython: boolean; fileExt: string }): string {
  // All package-install output is redirected to stderr so the only stdout
  // contribution before the user code is the entry script itself. The result
  // line is delimited by markers, which makes us robust to interleaving too.
  //
  // Preset packages are installed into a separate cache directory keyed by
  // hash(preset) so admins can change the preset list without invalidating
  // every user-deps cache.
  //
  // For Node, packages from BOTH caches are symlinked into /work/node_modules
  // so ESM `import` works — NODE_PATH alone only covers CommonJS `require()`.
  // For Python, PYTHONPATH is honored by the import system for both syntaxes,
  // so no per-package linking is needed.
  return [
    'set -e',
    // First-line stderr ensures the pod log is never empty even if the user
    // code exits before writing anything — that empty-log state used to come
    // back as "no result marker" with no breadcrumb to diagnose.
    'echo "[bootstrap] start lang=$TOOL_LANG ext=$TOOL_EXT" >&2',
    'mkdir -p /work && cd /work',
    'echo "$TOOL_ENTRY_B64" | base64 -d > /work/tool.' + opts.fileExt,
    'export __TOOL_PARAMS__="$(echo "$TOOL_PARAMS_B64" | base64 -d)"',
    '',
    '# Symlink every package from a source node_modules dir into',
    '# /work/node_modules. First writer wins (skips existing entries) so',
    '# user-code deps take priority over preset on transitive-dep collisions',
    '# when invoked user-first.',
    '__link_npm_packages__() {',
    '  __src="$1"',
    '  [ -d "$__src" ] || return 0',
    '  mkdir -p /work/node_modules',
    '  for __pkg in "$__src"/*; do',
    '    [ -e "$__pkg" ] || continue',
    '    __name=$(basename "$__pkg")',
    '    case "$__name" in',
    '      .*) continue ;;',
    '      @*)',
    '        mkdir -p "/work/node_modules/$__name"',
    '        for __sub in "$__pkg"/*; do',
    '          [ -e "$__sub" ] || continue',
    '          __sname=$(basename "$__sub")',
    '          [ -e "/work/node_modules/$__name/$__sname" ] || \\',
    '            ln -sfn "$__sub" "/work/node_modules/$__name/$__sname"',
    '        done',
    '        ;;',
    '      *)',
    '        [ -e "/work/node_modules/$__name" ] || \\',
    '          ln -sfn "$__pkg" "/work/node_modules/$__name"',
    '        ;;',
    '    esac',
    '  done',
    '}',
    '',
    '# --- Preset packages (admin-configured, shared across all jobs) ---',
    'if [ -n "$TOOL_PRESET_DEPS" ] && [ "$TOOL_PRESET_DEPS" != " " ]; then',
    '  PRESET_HASH=$(echo "$TOOL_PRESET_DEPS" | tr " " "\\n" | sort | md5sum | cut -d" " -f1)',
    '  if [ "$TOOL_LANG" = "python" ]; then',
    '    PRESET_DIR=/cache/pip-lib/_preset_$PRESET_HASH',
    '    if [ -d "$PRESET_DIR" ] && [ -n "$(ls -A "$PRESET_DIR" 2>/dev/null)" ]; then',
    '      echo "pip preset: cache hit ($PRESET_HASH)" >&2',
    '    else',
    '      echo "pip preset: cache miss ($PRESET_HASH), installing..." >&2',
    '      mkdir -p "$PRESET_DIR"',
    '      pip3 install --quiet --target "$PRESET_DIR" --cache-dir /cache/pip \\',
    '        -i https://pypi.tuna.tsinghua.edu.cn/simple \\',
    '        --trusted-host pypi.tuna.tsinghua.edu.cn \\',
    '        $TOOL_PRESET_DEPS 1>&2',
    '    fi',
    '    export PYTHONPATH="$PRESET_DIR:${PYTHONPATH:-}"',
    '  else',
    '    PRESET_DIR=/cache/npm-lib/_preset_$PRESET_HASH',
    '    if [ -d "$PRESET_DIR/node_modules" ]; then',
    '      echo "npm preset: cache hit ($PRESET_HASH)" >&2',
    '    else',
    '      echo "npm preset: cache miss ($PRESET_HASH), installing..." >&2',
    '      mkdir -p "$PRESET_DIR"',
    '      ( cd "$PRESET_DIR" && echo \'{}\' > package.json && \\',
    '        npm install --omit=dev --quiet \\',
    '          --cache /cache/npm \\',
    '          --registry https://registry.npmmirror.com \\',
    '          $TOOL_PRESET_DEPS 1>&2 )',
    '    fi',
    '    # NODE_PATH covers CJS require(); the symlinks below cover ESM import.',
    '    export NODE_PATH="$PRESET_DIR/node_modules:${NODE_PATH:-}"',
    '    __link_npm_packages__ "$PRESET_DIR/node_modules"',
    '  fi',
    'fi',
    '',
    '# --- User-code dependencies (per-job, hash-keyed) ---',
    'if [ -n "$TOOL_DEPS" ] && [ "$TOOL_DEPS" != " " ]; then',
    '  DEPS_HASH=$(echo "$TOOL_DEPS" | tr " " "\\n" | sort | md5sum | cut -d" " -f1)',
    '  if [ "$TOOL_LANG" = "python" ]; then',
    '    CACHE_DIR=/cache/pip-lib/$DEPS_HASH',
    '    if [ -d "$CACHE_DIR" ] && [ -n "$(ls -A "$CACHE_DIR" 2>/dev/null)" ]; then',
    '      echo "pip: cache hit ($DEPS_HASH)" >&2',
    '    else',
    '      echo "pip: cache miss ($DEPS_HASH), installing..." >&2',
    '      mkdir -p "$CACHE_DIR"',
    '      pip3 install --quiet --target "$CACHE_DIR" --cache-dir /cache/pip \\',
    '        -i https://pypi.tuna.tsinghua.edu.cn/simple \\',
    '        --trusted-host pypi.tuna.tsinghua.edu.cn \\',
    '        $TOOL_DEPS 1>&2',
    '    fi',
    '    export PYTHONPATH="$CACHE_DIR:${PYTHONPATH:-}"',
    '  else',
    '    CACHE_DIR=/cache/npm-lib/$DEPS_HASH',
    '    if [ -d "$CACHE_DIR/node_modules" ]; then',
    '      echo "npm: cache hit ($DEPS_HASH)" >&2',
    '    else',
    '      echo "npm: cache miss ($DEPS_HASH), installing..." >&2',
    '      # Install into a temp dir so we don\'t collide with preset symlinks',
    '      # already in /work/node_modules.',
    '      INSTALL_TMP=/tmp/npm-install-$$',
    '      mkdir -p "$INSTALL_TMP"',
    '      if [ "$TOOL_EXT" = "mjs" ]; then',
    '        echo \'{"type":"module"}\' > "$INSTALL_TMP/package.json"',
    '      else',
    '        echo \'{}\' > "$INSTALL_TMP/package.json"',
    '      fi',
    '      ( cd "$INSTALL_TMP" && \\',
    '        npm install --omit=dev --quiet \\',
    '          --cache /cache/npm \\',
    '          --registry https://registry.npmmirror.com \\',
    '          $TOOL_DEPS 1>&2 )',
    '      mkdir -p "$CACHE_DIR"',
    '      cp -r "$INSTALL_TMP/node_modules" "$CACHE_DIR/node_modules"',
    '      rm -rf "$INSTALL_TMP"',
    '    fi',
    '    __link_npm_packages__ "$CACHE_DIR/node_modules"',
    '  fi',
    'fi',
    '',
    'cd /work',
    'if [ "$TOOL_LANG" = "python" ]; then',
    '  exec python3 /work/tool.py',
    'else',
    '  exec node /work/tool.' + opts.fileExt,
    'fi',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Dependency extraction (server-side, matches warm-pool patterns)
// ---------------------------------------------------------------------------

const JS_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'url', 'util', 'stream',
  'buffer', 'events', 'querystring', 'zlib', 'child_process', 'net', 'tls',
  'dns', 'readline', 'assert', 'cluster', 'dgram', 'domain', 'inspector',
  'perf_hooks', 'string_decoder', 'timers', 'tty', 'v8', 'vm', 'worker_threads',
])

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

const SAFE_PKG_NAME = /^[@a-z0-9][\w.\-/]*$/i

/**
 * Extract third-party package deps from user code.
 *
 * @param presetDeps Packages already provided by the admin-configured preset.
 *   These are excluded from the result so the per-job cache doesn't redundantly
 *   reinstall them — preset packages are already exposed to the running tool
 *   via NODE_PATH + /work/node_modules symlinks (npm) or PYTHONPATH (pip).
 */
function extractDeps(
  code: string,
  language: 'javascript' | 'python',
  presetDeps: string[] = []
): string[] {
  const deps = new Set<string>()
  if (language === 'python') {
    const re = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      const pkg = m[1]
      if (!PY_STDLIB.has(pkg)) deps.add(PY_IMPORT_TO_PIP[pkg] ?? pkg)
    }
  } else {
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
  const presetSet = new Set(presetDeps)
  const arr = Array.from(deps).filter((d) => !presetSet.has(d))
  for (const d of arr) {
    if (!SAFE_PKG_NAME.test(d)) {
      throw new Error(`Invalid dependency name: ${d}`)
    }
  }
  return arr
}

// ---------------------------------------------------------------------------
// Job spec
// ---------------------------------------------------------------------------

interface JobSpecOpts {
  name: string
  image: string
  bootstrap: string
  env: Array<{ name: string; value: string }>
  timeoutMs: number
  isPython: boolean
}

function buildJobSpec(opts: JobSpecOpts): Record<string, unknown> {
  const deadlineSec = Math.max(30, Math.ceil(opts.timeoutMs / 1000) + 10)

  const volumeMounts: Array<Record<string, unknown>> = [
    { name: 'deps-cache', mountPath: '/cache' },
  ]
  if (opts.isPython) {
    // Shared with deploy-skill / warm-pool playwright browser cache.
    volumeMounts.push({
      name: 'deps-cache',
      mountPath: '/root/.cache/ms-playwright',
      subPath: 'playwright-browsers',
    })
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: opts.name,
      namespace: K8S_NAMESPACE,
      labels: { app: 'crewmeld-tool-job' },
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      backoffLimit: 0,
      activeDeadlineSeconds: deadlineSec,
      template: {
        metadata: { labels: { app: 'crewmeld-tool-job', 'job-name': opts.name } },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'tool',
              image: opts.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c'],
              args: [opts.bootstrap],
              env: opts.env,
              volumeMounts,
              resources: {
                limits: { cpu: '500m', memory: '512Mi' },
                requests: { cpu: '100m', memory: '128Mi' },
              },
            },
          ],
          volumes: [
            {
              name: 'deps-cache',
              persistentVolumeClaim: { claimName: 'crewmeld-deps-cache' },
            },
          ],
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Job lifecycle: poll status, find pod, read log, delete
// ---------------------------------------------------------------------------

interface JobFinalStatus {
  succeeded: boolean
  failed: boolean
  reason?: string
  message?: string
}

async function pollJob(jobName: string, totalTimeoutMs: number): Promise<JobFinalStatus> {
  const deadline = Date.now() + totalTimeoutMs
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await k8sApi(`/apis/batch/v1/namespaces/${K8S_NAMESPACE}/jobs/${jobName}`, {
      method: 'GET',
    })
    if (!res.ok) {
      // Job may have been TTL-collected before we polled — treat as failure here;
      // the caller will surface a generic message and the log path will likely
      // also miss the pod.
      if (res.status === 404) {
        return { succeeded: false, failed: true, reason: 'JobNotFound' }
      }
      const body = await res.text()
      throw new Error(`Job status query failed: ${body.slice(0, 200)}`)
    }
    const job = (await res.json()) as {
      status?: {
        succeeded?: number
        failed?: number
        conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>
      }
    }
    const status = job.status ?? {}
    if ((status.succeeded ?? 0) > 0) {
      return { succeeded: true, failed: false }
    }
    if ((status.failed ?? 0) > 0) {
      const cond = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True')
      return { succeeded: false, failed: true, reason: cond?.reason, message: cond?.message }
    }

    if (Date.now() > deadline) {
      return {
        succeeded: false,
        failed: true,
        reason: 'PollTimeout',
        message: `Job did not finish within ${totalTimeoutMs}ms`,
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

async function findJobPod(jobName: string): Promise<string | null> {
  const res = await k8sApi(
    `/api/v1/namespaces/${K8S_NAMESPACE}/pods?labelSelector=job-name=${jobName}`,
    { method: 'GET' }
  )
  if (!res.ok) return null
  const body = (await res.json()) as {
    items?: Array<{ metadata: { name: string } }>
  }
  return body.items?.[0]?.metadata?.name ?? null
}

async function readPodLog(podName: string): Promise<string> {
  // limitBytes caps memory if the user code prints a lot. The result marker
  // lives at the tail so we only need the last chunk.
  //
  // Accept must be "*/*" — newer clusters (k3s/k8s with strict media-type
  // validation) reject "text/plain" on this endpoint with HTTP 406 even
  // though the response body itself is plain text. "*/*" lets the apiserver
  // negotiate its default (plain text for pod logs).
  const res = await k8sApi(
    `/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}/log?limitBytes=1048576`,
    { method: 'GET', accept: '*/*' }
  )
  if (!res.ok) {
    // Surface the API failure: silently returning '' here used to hide the
    // real reason behind a generic "no result marker" error.
    const body = await res.text().catch(() => '')
    logger.warn('Pod log fetch failed', {
      podName,
      status: res.status,
      bodyPreview: body.slice(0, 200),
    })
    return ''
  }
  return res.text()
}

/**
 * Read pod logs with backoff retry. kubelet may flip Pod.phase=Succeeded
 * before flushing the container's stdout buffer to its log file, so a single
 * fetch right after job completion can come back with HTTP 200 + empty body.
 * Retry until the result marker appears or the deadline expires.
 */
const LOG_RETRY_DEADLINE_MS = 8000
const LOG_RETRY_INTERVAL_MS = 500

async function readPodLogWithRetry(
  podName: string,
  jobName: string,
  jobSucceeded: boolean
): Promise<string> {
  let logs = await readPodLog(podName)
  if (logs.includes(RESULT_BEGIN)) return logs

  // Only retry when the Job actually succeeded — for failed jobs the empty
  // log is the real answer and waiting longer just delays the error.
  if (!jobSucceeded) return logs

  const deadline = Date.now() + LOG_RETRY_DEADLINE_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await sleep(LOG_RETRY_INTERVAL_MS)
    const next = await readPodLog(podName)
    if (next.includes(RESULT_BEGIN)) {
      logger.info('Pod log marker appeared after retry', {
        jobName,
        podName,
        attempt,
        elapsedMs: LOG_RETRY_INTERVAL_MS * attempt,
      })
      return next
    }
    // Keep the longest non-empty body we've seen so diagnostics aren't lost
    // if a later attempt regresses to empty.
    if (next.length > logs.length) logs = next
  }

  logger.warn('Pod log marker missing after retry deadline', {
    jobName,
    podName,
    deadlineMs: LOG_RETRY_DEADLINE_MS,
    attempts: attempt,
    finalLogBytes: logs.length,
  })
  return logs
}

interface PodDiagnostics {
  phase?: string
  reason?: string
  message?: string
  containerWaiting?: { reason?: string; message?: string }
  containerTerminated?: { exitCode?: number; reason?: string; message?: string }
  failedCondition?: { reason?: string; message?: string }
}

async function readPodStatus(podName: string): Promise<PodDiagnostics | null> {
  const res = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, {
    method: 'GET',
  })
  if (!res.ok) return null
  const body = (await res.json()) as {
    status?: {
      phase?: string
      reason?: string
      message?: string
      conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>
      containerStatuses?: Array<{
        name: string
        state?: {
          waiting?: { reason?: string; message?: string }
          terminated?: { exitCode?: number; reason?: string; message?: string }
        }
        lastState?: {
          terminated?: { exitCode?: number; reason?: string; message?: string }
        }
      }>
    }
  }
  const status = body.status ?? {}
  const tool = status.containerStatuses?.find((c) => c.name === 'tool')
  // Prefer the current container state; fall back to lastState for terminated
  // containers that have since been replaced or are in the process of cleanup.
  const term = tool?.state?.terminated ?? tool?.lastState?.terminated
  const failedCond = (status.conditions ?? []).find(
    (c) =>
      c.status === 'False' &&
      (c.type === 'PodScheduled' || c.type === 'ContainersReady' || c.type === 'Ready')
  )
  return {
    phase: status.phase,
    reason: status.reason,
    message: status.message,
    containerWaiting: tool?.state?.waiting,
    containerTerminated: term,
    failedCondition: failedCond
      ? { reason: failedCond.reason, message: failedCond.message }
      : undefined,
  }
}

function formatPodDiagnostics(diag: PodDiagnostics): string {
  const parts: string[] = []
  if (diag.phase) parts.push(`phase=${diag.phase}`)
  if (diag.reason) parts.push(`podReason=${diag.reason}`)
  if (diag.message) parts.push(`podMessage=${truncate(diag.message, 200)}`)
  if (diag.containerWaiting?.reason) {
    const w = diag.containerWaiting
    parts.push(`waiting=${w.reason}${w.message ? `: ${truncate(w.message, 200)}` : ''}`)
  }
  if (diag.containerTerminated) {
    const t = diag.containerTerminated
    const bits: string[] = [`exitCode=${t.exitCode ?? '?'}`]
    if (t.reason) bits.push(`reason=${t.reason}`)
    if (t.message) bits.push(`message=${truncate(t.message, 200)}`)
    parts.push(`terminated(${bits.join(', ')})`)
  }
  if (diag.failedCondition?.reason && !diag.containerWaiting && !diag.containerTerminated) {
    const f = diag.failedCondition
    parts.push(`failed=${f.reason}${f.message ? `: ${truncate(f.message, 200)}` : ''}`)
  }
  return parts.join('; ')
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

async function deleteJob(jobName: string): Promise<void> {
  // propagationPolicy=Background cascades Pod deletion without blocking.
  await k8sApi(
    `/apis/batch/v1/namespaces/${K8S_NAMESPACE}/jobs/${jobName}?propagationPolicy=Background`,
    { method: 'DELETE' }
  )
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

async function parseToolOutput(
  logs: string,
  status: JobFinalStatus,
  jobName: string,
  podName: string | null
): Promise<unknown> {
  const beginIdx = logs.lastIndexOf(RESULT_BEGIN)
  const endIdx = logs.lastIndexOf(RESULT_END)
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const payload = logs.slice(beginIdx + RESULT_BEGIN.length, endIdx)
    try {
      const parsed = JSON.parse(payload) as { __result__?: unknown; __error__?: string }
      if (parsed.__error__) throw new Error(parsed.__error__)
      return parsed.__result__ ?? null
    } catch (err) {
      throw new Error(
        `Failed to parse tool result (job ${jobName}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // No marker — fall back to status + tail of logs for diagnostics
  if (status.reason === 'DeadlineExceeded') {
    throw new Error(`Tool job timed out: ${status.message ?? ''}`)
  }
  if (status.reason === 'PollTimeout') {
    throw new Error(status.message ?? 'Tool job poll timed out')
  }

  // When pod logs are empty the failure usually happened before the container
  // could write anything (scheduling, image pull, OOMKilled at start). Probe
  // the Pod's status so the caller sees the real reason instead of a generic
  // "no result marker" string.
  const podDiag =
    logs.length === 0 && podName
      ? await readPodStatus(podName).catch(() => null)
      : null
  const podDiagText = podDiag ? formatPodDiagnostics(podDiag) : ''

  const tail = logs.split('\n').slice(-20).join('\n').trim()
  const parts: string[] = [`Tool job ${jobName} produced no result marker.`]
  if (status.reason || status.message) {
    const jobBits: string[] = []
    if (status.reason) jobBits.push(`reason=${status.reason}`)
    if (status.message) jobBits.push(`message=${truncate(status.message, 200)}`)
    parts.push(`Job: ${jobBits.join(' ')}`)
  }
  if (podDiagText) {
    parts.push(`Pod: ${podDiagText}`)
  } else if (logs.length === 0 && !podName) {
    parts.push('Pod: not found (likely GC\'d before logs were read)')
  }
  // Pod exited cleanly but its log capture is empty even after the read
  // retry loop — almost always a kubelet/CRI log-flush delay rather than a
  // user-code bug. Flag it explicitly so operators don't chase the wrong cause.
  if (status.succeeded && logs.length === 0) {
    parts.push(
      `Hint: Pod log unavailable after ${LOG_RETRY_DEADLINE_MS}ms retry — likely kubelet log flush delay or log GC; check kubelet/containerd logs on the pod's node.`
    )
  }
  if (tail) {
    parts.push(`Tail:\n${tail}`)
  }

  logger.error('Tool job produced no result marker', {
    jobName,
    podName,
    jobReason: status.reason,
    jobMessage: status.message,
    podPhase: podDiag?.phase,
    podReason: podDiag?.reason,
    containerWaiting: podDiag?.containerWaiting?.reason,
    containerTerminated: podDiag?.containerTerminated?.reason,
    containerExitCode: podDiag?.containerTerminated?.exitCode,
    hasLogs: logs.length > 0,
  })

  throw new Error(parts.join(' '))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
