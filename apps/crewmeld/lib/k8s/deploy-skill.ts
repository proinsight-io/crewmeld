import http from 'http'
import https from 'https'
import { createLogger } from '@crewmeld/logger'
import type { SkillLanguage, SkillPackage } from '@/app/(employee)/skills/types'
import {
  buildJsResolvePrelude,
  buildPyResolvePrelude,
  extractParamResolution,
  type ParamResolution,
} from '@/lib/tools/param-resolution'
import { allocateFromPool, findAssignedPod, isWarmPoolEnabled, recycleToPool } from './warm-pool'

const logger = createLogger('K8sDeploySkill')

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ''
const K8S_API_TOKEN = process.env.K8S_API_TOKEN ?? ''
const K8S_NAMESPACE = process.env.K8S_DEPLOY_NAMESPACE ?? 'crewmeld-skills'
const K8S_NODE_IP = process.env.K8S_NODE_IP ?? ''
const K8S_SKIP_TLS = process.env.K8S_SKIP_TLS_VERIFY === 'true'

// ---------------------------------------------------------------------------
// K8S API general request (using Node.js native https module, supports skipping self-signed certs)
// ---------------------------------------------------------------------------

interface K8sFetchOptions {
  method: string
  body?: unknown
}

interface K8sResponse {
  ok: boolean
  status: number
  json: () => Promise<Record<string, unknown>>
  text: () => Promise<string>
}

function k8sApi(path: string, opts: K8sFetchOptions): Promise<K8sResponse> {
  const url = new URL(path, K8S_API_SERVER)
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
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        // Standard Node https module way to ignore self-signed certs
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
// Resource name normalization
// ---------------------------------------------------------------------------

function sanitizeName(id: string): string {
  return `skill-${id
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
    .slice(0, 50)}`
}

// ---------------------------------------------------------------------------
// Image selection (by language)
// ---------------------------------------------------------------------------

// Pinned base images. Avoid :latest — it forces operators to maintain a
// pre-pull pipeline (since :latest historically required imagePullPolicy:Never)
// and produces non-reproducible builds. Bump these tags deliberately.
const IMAGE_MAP: Record<SkillLanguage, string> = {
  javascript: process.env.K8S_IMAGE_NODE ?? 'docker.io/library/node:22-bookworm',
  python: process.env.K8S_IMAGE_PYTHON ?? 'docker.io/library/python:3.12-bookworm',
}

function getImage(language: SkillLanguage = 'javascript'): string {
  return IMAGE_MAP[language] ?? IMAGE_MAP.javascript
}

// ---------------------------------------------------------------------------
// HTTP Server wrapper code (injected into ConfigMap)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JS Server — simple mode (no import, uses new Function sandbox execution)
// ---------------------------------------------------------------------------
const JS_SERVER_SIMPLE = `
import { readFileSync } from 'fs';
import { createServer } from 'http';

const toolCode = readFileSync('/app/tool.js', 'utf-8');

const SAFE_IDENT = /^[\\p{L}_$][\\p{L}\\p{N}_$]*$/u;

// Optional defaults.json: { preset, envMap, types } — see deploy-skill.ts.
// Merged into request params so secret/connection params (e.g. CONN_HOST) reach
// the tool code even when the caller omits them in the request body.
let __defaults__ = { preset: {}, envMap: {}, types: {} };
try { __defaults__ = JSON.parse(readFileSync('/app/defaults.json', 'utf-8')); } catch {}
const __coerce__ = (v, t) => {
  if (v === undefined || v === null || v === '') return v;
  if (t === 'number') { const n = Number(v); return Number.isFinite(n) ? n : v; }
  if (t === 'boolean') return v === true || v === 'true' || v === 1 || v === '1';
  return v;
};
const __presetCoerced__ = {};
for (const [__k__, __v__] of Object.entries(__defaults__.preset || {})) __presetCoerced__[__k__] = __coerce__(__v__, (__defaults__.types || {})[__k__]);
const __envFilled__ = {};
for (const [__k__, __envName__] of Object.entries(__defaults__.envMap || {})) {
  const __ev__ = process.env[__envName__];
  if (__ev__ !== undefined && __ev__ !== '') __envFilled__[__k__] = __coerce__(__ev__, (__defaults__.types || {})[__k__]);
}
const __baseParams__ = Object.assign({}, __presetCoerced__, __envFilled__);

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let bodyParams = {};
  try { bodyParams = JSON.parse(body); } catch {}

  // Validate body keys before merge (preset/env keys came through generation-time validation)
  for (const key of Object.keys(bodyParams)) {
    if (!SAFE_IDENT.test(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid param name: ' + key }));
      return;
    }
  }
  const params = Object.assign({}, __baseParams__, bodyParams);
  const paramKeys = Object.keys(params);

  const paramLines = paramKeys
    .map(k => 'const ' + k + ' = __params__[' + JSON.stringify(k) + '];')
    .join('\\n');

  const __envSecrets__ = Object.values(process.env).filter(v => v && v.length > 6);
  const __safeFetch__ = async (url, opts) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const s of __envSecrets__) { if (u.includes(s)) throw new Error('Security: env var value in URL is blocked'); }
    return globalThis.fetch(url, opts);
  };

  const wrapped = 'return (async () => {\\n' + paramLines + '\\n' + toolCode + '\\n})();';
  try {
    const fn = new Function('__params__', 'fetch', wrapped);
    const result = await fn(params, __safeFetch__);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, result: result ?? null }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});

server.listen(3000, () => console.log('Skill server listening on :3000'));
`.trim()

// ---------------------------------------------------------------------------
// JS Server — module mode (has import/require, tool code exports run function)
// ---------------------------------------------------------------------------
const JS_SERVER_MODULE = `
import { createServer } from 'http';
import { run } from './tool.mjs';

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let params = {};
  try { params = JSON.parse(body); } catch {}

  try {
    const result = await run(params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // If tool returns object with success, pass through directly (supports files and other fields)
    if (result && typeof result === 'object' && 'success' in result) {
      res.end(JSON.stringify(result));
    } else {
      res.end(JSON.stringify({ success: true, result: result ?? null }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});

server.listen(3000, () => console.log('Skill server listening on :3000'));
`.trim()

const PY_SERVER_CODE = `
import json, sys, os, traceback, subprocess, importlib, importlib.util
from http.server import HTTPServer, BaseHTTPRequestHandler

# Load tool.py as a module (supports importing third-party libraries)
def load_tool_module():
    spec = importlib.util.spec_from_file_location("tool", "/app/tool.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["tool"] = mod
    spec.loader.exec_module(mod)
    return mod

tool_module = None

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b'{}'
        params = json.loads(body) if body else {}
        try:
            # Execute tool.py in a subprocess — fully isolated Python environment, free to import
            env = {**os.environ, '__TOOL_PARAMS__': json.dumps(params)}
            proc = subprocess.run(
                [sys.executable, '/app/tool.py'],
                capture_output=True, text=True, timeout=60, env=env
            )
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()
            if proc.returncode != 0:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': stderr or stdout or 'exit code ' + str(proc.returncode)}).encode())
                return
            # Parse output (last line should be JSON)
            result = json.loads(stdout) if stdout else None
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if isinstance(result, dict) and 'success' in result:
                self.wfile.write(json.dumps(result).encode())
            else:
                self.wfile.write(json.dumps({'success': True, 'result': result}).encode())
        except subprocess.TimeoutExpired:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': 'execution timeout (60s)'}).encode())
        except Exception:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': traceback.format_exc()}).encode())

print('Skill server listening on :3000')
HTTPServer(('', 3000), Handler).serve_forever()
`.trim()

// ---------------------------------------------------------------------------
// ConfigMap
// ---------------------------------------------------------------------------

// Python standard library module list (no pip install needed)
const PY_STDLIB = new Set([
  'abc',
  'aifc',
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
  'cgitb',
  'cmd',
  'code',
  'codecs',
  'codeop',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'cProfile',
  'csv',
  'ctypes',
  'curses',
  'dataclasses',
  'datetime',
  'dbm',
  'decimal',
  'difflib',
  'dis',
  'distutils',
  'doctest',
  'email',
  'encodings',
  'enum',
  'errno',
  'faulthandler',
  'fcntl',
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
  'grp',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'idlelib',
  'imaplib',
  'imghdr',
  'imp',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'lib2to3',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'mailcap',
  'marshal',
  'math',
  'mimetypes',
  'mmap',
  'modulefinder',
  'multiprocessing',
  'netrc',
  'numbers',
  'operator',
  'optparse',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'pipes',
  'pkgutil',
  'platform',
  'plistlib',
  'poplib',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'pty',
  'pwd',
  'py_compile',
  'pyclbr',
  'pydoc',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'rlcompleter',
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
  'smtpd',
  'smtplib',
  'sndhdr',
  'socket',
  'socketserver',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'sunau',
  'symtable',
  'sys',
  'sysconfig',
  'syslog',
  'tabnanny',
  'tarfile',
  'telnetlib',
  'tempfile',
  'termios',
  'test',
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
  'turtledemo',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uu',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'winreg',
  'winsound',
  'wsgiref',
  'xdrlib',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
  '_thread',
])

// Node.js built-in modules (no npm install needed)
const JS_BUILTIN = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'node:assert',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:console',
  'node:crypto',
  'node:dgram',
  'node:dns',
  'node:events',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:inspector',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:process',
  'node:querystring',
  'node:readline',
  'node:repl',
  'node:stream',
  'node:string_decoder',
  'node:timers',
  'node:tls',
  'node:tty',
  'node:url',
  'node:util',
  'node:v8',
  'node:vm',
  'node:worker_threads',
  'node:zlib',
])

/** Extract third-party dependencies from JS code */
function extractJsDeps(code: string): string[] {
  const deps = new Set<string>()
  // import ... from 'pkg' or import 'pkg'
  const importRe = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(code)) !== null) {
    const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
    if (!JS_BUILTIN.has(pkg)) deps.add(pkg)
  }
  // require('pkg')
  const requireRe = /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g
  while ((m = requireRe.exec(code)) !== null) {
    const pkg = m[1].startsWith('@') ? m[1] : m[1].split('/')[0]
    if (!JS_BUILTIN.has(pkg)) deps.add(pkg)
  }
  return Array.from(deps)
}

/** Wrap Python tool code as standalone executable script (read params from env vars, output JSON to stdout) */
function wrapPyToolCode(code: string, resolution: ParamResolution): string {
  const lines = code.split('\n')
  const imports: string[] = []
  const body: string[] = []
  for (const line of lines) {
    if (/^\s*(import\s|from\s)/.test(line)) {
      imports.push(line)
    } else {
      body.push(line)
    }
  }
  return [
    ...imports,
    'import json, os, sys',
    '',
    '__params__ = json.loads(os.environ.get("__TOOL_PARAMS__", "{}"))',
    buildPyResolvePrelude(resolution),
    'for __k__, __v__ in __merged__.items(): globals()[__k__] = __v__',
    '',
    'try:',
    ...body.map((l) => `    ${l}`),
    '    print(json.dumps({"success": True, "result": result if "result" in dir() else None}))',
    'except Exception as e:',
    '    print(json.dumps({"success": False, "error": str(e)}))',
  ].join('\n')
}

/** Python import name to pip package name mapping */
const PY_IMPORT_TO_PIP: Record<string, string> = {
  mysql: 'mysql-connector-python',
  pymysql: 'PyMySQL',
  cv2: 'opencv-python',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  yaml: 'PyYAML',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  docx: 'python-docx',
  pptx: 'python-pptx',
  attr: 'attrs',
  serial: 'pyserial',
  Crypto: 'pycryptodome',
}

/** Extract third-party dependencies from Python code */
function extractPyDeps(code: string): string[] {
  const deps = new Set<string>()
  const importRe = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm
  let m: RegExpExecArray | null
  while ((m = importRe.exec(code)) !== null) {
    const pkg = m[1]
    if (!PY_STDLIB.has(pkg)) {
      deps.add(PY_IMPORT_TO_PIP[pkg] ?? pkg)
    }
  }
  return Array.from(deps)
}

/**
 * Wrap tool code as ESM module: extract top-level imports, wrap remaining code in export async function run(params)
 * paramNames from tool parameters schema, for destructuring params as local variables.
 *
 * Resolution metadata is inlined as JS literals so the deployed pod can fill missing
 * params from process.env (e.g. CONN_HOST) and presetParams without external files.
 */
function wrapAsEsmModule(
  code: string,
  paramNames: string[],
  resolution: ParamResolution
): string {
  const lines = code.split('\n')
  const imports: string[] = []
  const body: string[] = []
  for (const line of lines) {
    if (/^\s*(import\s|import\{)/.test(line)) {
      imports.push(line)
    } else {
      body.push(line)
    }
  }
  // Destructure params (from the merged object) as local variables
  const destructure =
    paramNames.length > 0 ? `  const { ${paramNames.join(', ')} } = __merged__;` : ''
  return [
    ...imports,
    '',
    'export async function run(params) {',
    buildJsResolvePrelude(resolution, '  '),
    destructure,
    ...body.map((l) => `  ${l}`),
    '}',
  ].join('\n')
}

function buildConfigMap(skill: SkillPackage) {
  const name = sanitizeName(skill.id)
  const lang = skill.language ?? 'javascript'
  const isJs = lang === 'javascript'

  const jsDeps = isJs ? extractJsDeps(skill.code ?? '') : []
  const hasImports = jsDeps.length > 0 || /\bimport\s/.test(skill.code ?? '')

  const resolution = extractParamResolution(skill.parameters, skill.presetParams)

  let data: Record<string, string>

  if (isJs) {
    if (hasImports) {
      // Module mode: tool code wrapped as ESM exporting run function
      data = {
        'server.mjs': JS_SERVER_MODULE,
        'tool.mjs': wrapAsEsmModule(
          skill.code ?? '',
          Object.keys((skill.parameters?.properties as Record<string, unknown>) ?? {}),
          resolution
        ),
        ...(jsDeps.length > 0
          ? {
              'package.json': JSON.stringify({
                type: 'module',
                dependencies: Object.fromEntries(jsDeps.map((d) => [d, 'latest'])),
              }),
            }
          : {}),
      }
    } else {
      // Simple mode: new Function sandbox execution. defaults.json carries the
      // preset/envMap/types bundle; server.mjs reads it once at boot to merge.
      data = {
        'server.mjs': JS_SERVER_SIMPLE,
        'tool.js': skill.code ?? '',
        'defaults.json': JSON.stringify(resolution),
      }
    }
  } else {
    data = {
      'server.py': PY_SERVER_CODE,
      'tool.py': wrapPyToolCode(skill.code ?? '', resolution),
      'requirements.txt': extractPyDeps(skill.code ?? '').join('\n'),
    }
  }

  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace: K8S_NAMESPACE,
      labels: { app: 'crewmeld-skill', 'skill-id': name },
    },
    data,
  }
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

function buildDeployment(skill: SkillPackage) {
  const name = sanitizeName(skill.id)
  const lang = skill.language ?? 'javascript'
  const isJs = lang === 'javascript'
  const image = getImage(lang)

  const hasJsDeps = isJs && extractJsDeps(skill.code ?? '').length > 0

  // Start command: use dependency content hash as dir name, skip install on hit
  // npm: persist node_modules to /cache/npm-lib/<hash>, symlink to /app/node_modules
  // pip: persist site-packages to /cache/pip-lib/<hash>, set PYTHONPATH
  const npmInstallCmd = [
    'cd /app',
    'DEPS_HASH=$(md5sum /app/package.json 2>/dev/null | cut -d" " -f1 || echo none)',
    'if [ -d "/cache/npm-lib/$DEPS_HASH/node_modules" ]; then',
    '  echo "npm: cache hit ($DEPS_HASH), skipping install"',
    '  ln -s "/cache/npm-lib/$DEPS_HASH/node_modules" /app/node_modules',
    'else',
    '  echo "npm: cache miss ($DEPS_HASH), installing..."',
    '  npm install --omit=dev --quiet --cache /cache/npm --registry https://registry.npmmirror.com 2>&1',
    '  mkdir -p "/cache/npm-lib/$DEPS_HASH"',
    '  cp -r /app/node_modules "/cache/npm-lib/$DEPS_HASH/node_modules"',
    'fi',
    'exec node --experimental-fetch /app/server.mjs',
  ].join('\n')

  const pipInstallCmd = [
    // Global pip mirror source setting (pip install in tool code also auto-uses Tsinghua mirror)
    'export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn',
    'DEPS_HASH=$(md5sum /app/requirements.txt 2>/dev/null | cut -d" " -f1 || echo none)',
    'if [ -d "/cache/pip-lib/$DEPS_HASH" ] && [ "$(ls -A /cache/pip-lib/$DEPS_HASH 2>/dev/null)" ]; then',
    '  echo "pip: cache hit ($DEPS_HASH), skipping install"',
    'else',
    '  echo "pip: cache miss ($DEPS_HASH), installing..."',
    '  pip install -r /app/requirements.txt --target "/cache/pip-lib/$DEPS_HASH" --cache-dir /cache/pip -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn 2>&1',
    'fi',
    'export PYTHONPATH="/cache/pip-lib/$DEPS_HASH:$PYTHONPATH"',
    'exec python /app/server.py',
  ].join('\n')

  const command = isJs
    ? hasJsDeps
      ? ['sh', '-c', npmInstallCmd]
      : ['node', '--experimental-fetch', '/app/server.mjs']
    : ['sh', '-c', pipInstallCmd]

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: K8S_NAMESPACE,
      labels: { app: 'crewmeld-skill', 'skill-id': name },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'crewmeld-skill', 'skill-id': name } },
      template: {
        metadata: { labels: { app: 'crewmeld-skill', 'skill-id': name } },
        spec: {
          initContainers: [
            {
              name: 'copy-code',
              image,
              // Always IfNotPresent: with pinned tags (no :latest), this means
              // "use the cached layer if present, otherwise pull once". Avoids
              // the dead-on-arrival ErrImageNeverPull when prepull missed.
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', 'cp -rL /code-ro/. /app/'],
              volumeMounts: [
                { name: 'code-ro', mountPath: '/code-ro' },
                { name: 'app', mountPath: '/app' },
              ],
            },
          ],
          containers: [
            {
              name: 'skill',
              image,
              // Always IfNotPresent: with pinned tags (no :latest), this means
              // "use the cached layer if present, otherwise pull once". Avoids
              // the dead-on-arrival ErrImageNeverPull when prepull missed.
              imagePullPolicy: 'IfNotPresent',
              command,
              ports: [{ containerPort: 3000 }],
              volumeMounts: [
                { name: 'app', mountPath: '/app' },
                { name: 'deps-cache', mountPath: '/cache' },
                // Python: cache playwright browser binaries to PVC, avoid re-download on each cold start (~200MB)
                ...(!isJs
                  ? [
                      {
                        name: 'deps-cache',
                        mountPath: '/root/.cache/ms-playwright',
                        subPath: 'playwright-browsers',
                      },
                    ]
                  : []),
              ],
              env: [
                ...(skill.envVars ?? []).map((e) => ({
                  name: e.name,
                  value: String(e.value ?? ''),
                })),
                { name: 'MINIO_ENDPOINT', value: process.env.MINIO_ENDPOINT ?? '' },
                { name: 'MINIO_ACCESS_KEY', value: process.env.MINIO_ACCESS_KEY ?? '' },
                { name: 'MINIO_SECRET_KEY', value: process.env.MINIO_SECRET_KEY ?? '' },
                { name: 'MINIO_BUCKET', value: process.env.MINIO_BUCKET ?? 'tool-files' },
                { name: 'MINIO_PUBLIC_URL', value: process.env.MINIO_PUBLIC_URL ?? '' },
              ],
              resources: {
                limits: { cpu: '500m', memory: isJs ? '256Mi' : '512Mi' },
                requests: { cpu: '100m', memory: isJs ? '64Mi' : '128Mi' },
              },
              livenessProbe: {
                httpGet: { path: '/health', port: 3000 },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                failureThreshold: 6,
              },
              readinessProbe: {
                httpGet: { path: '/health', port: 3000 },
                initialDelaySeconds: 5,
                periodSeconds: 3,
                failureThreshold: 12,
              },
            },
          ],
          volumes: [
            {
              name: 'code-ro',
              configMap: { name },
            },
            {
              name: 'app',
              emptyDir: {},
            },
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
// Service (NodePort)
// ---------------------------------------------------------------------------

function buildService(skill: SkillPackage) {
  const name = sanitizeName(skill.id)
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: K8S_NAMESPACE,
      labels: { app: 'crewmeld-skill', 'skill-id': name },
    },
    spec: {
      type: 'NodePort',
      selector: { app: 'crewmeld-skill', 'skill-id': name },
      ports: [{ port: 3000, targetPort: 3000 }],
    },
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

async function applyResource(
  apiPath: string,
  resource: Record<string, unknown>,
  resourceName: string
): Promise<void> {
  // Try to create, update if already exists
  const createRes = await k8sApi(apiPath, { method: 'POST', body: resource })
  if (createRes.ok) {
    logger.info(`Created ${resourceName} successfully`)
    return
  }
  const createBody = (await createRes.json()) as { reason?: string }
  if (createBody.reason === 'AlreadyExists') {
    const name = (resource.metadata as { name: string }).name
    const putRes = await k8sApi(`${apiPath}/${name}`, { method: 'PUT', body: resource })
    if (!putRes.ok) {
      const err = await putRes.text()
      throw new Error(`Failed to update ${resourceName}: ${err}`)
    }
    logger.info(`Updated ${resourceName} successfully`)
    return
  }
  throw new Error(`Failed to create ${resourceName}: ${JSON.stringify(createBody)}`)
}

async function deleteResource(apiPath: string, name: string): Promise<void> {
  const res = await k8sApi(`${apiPath}/${name}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const err = await res.text()
    logger.warn(`Failed to delete ${name}: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isK8sConfigured(): boolean {
  return Boolean(K8S_API_SERVER && K8S_API_TOKEN)
}

/**
 * Whether K8S calls should be mocked. Enables local development without a
 * real cluster — every entry point returns a fake-but-shaped response.
 */
export function isK8sMockMode(): boolean {
  return process.env.K8S_MOCK === 'true'
}

// Re-export warm pool API
export { initWarmPool, isWarmPoolEnabled } from './warm-pool'

/** Ensure target namespace exists, try to create if not, give ops hint when permission insufficient */
async function ensureNamespace(): Promise<void> {
  const path = `/api/v1/namespaces/${K8S_NAMESPACE}`
  const res = await k8sApi(path, { method: 'GET' })
  if (res.ok) return

  logger.info(`Namespace ${K8S_NAMESPACE} not found, attempting to create...`)
  const createRes = await k8sApi('/api/v1/namespaces', {
    method: 'POST',
    body: {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: K8S_NAMESPACE },
    },
  })
  if (createRes.ok) {
    logger.info(`Namespace ${K8S_NAMESPACE} created successfully`)
    return
  }

  const createBody = await createRes.text()
  if (createRes.status === 403) {
    throw new Error(
      `Namespace ${K8S_NAMESPACE} does not exist and the current service account lacks permission to create it. Please have the cluster admin run: kubectl create namespace ${K8S_NAMESPACE}`
    )
  }
  throw new Error(
    `Failed to create namespace ${K8S_NAMESPACE} (${createRes.status}): ${createBody}`
  )
}

/** Deploy skill to K8S (prefer warm pool, fall back to traditional method when pool unavailable) */
export async function deploySkill(skill: SkillPackage): Promise<{
  endpoint: string
  nodePort: number
}> {
  if (isK8sMockMode()) {
    const mockPort = 30000 + (Math.abs(hashString(skill.id)) % 1000)
    logger.info(`K8S_MOCK: returning fake endpoint for skill ${skill.id}`)
    return { endpoint: `http://mock-k8s:${mockPort}`, nodePort: mockPort }
  }
  if (!isK8sConfigured()) {
    throw new Error('K8S not configured, please set K8S_API_SERVER and K8S_API_TOKEN in .env.local')
  }
  if (!skill.code) {
    throw new Error('This skill has no code and cannot be deployed')
  }

  await ensureNamespace()

  // --- Try warm pool ---
  if (isWarmPoolEnabled()) {
    const jsDeps = extractJsDeps(skill.code)
    const hasImports = jsDeps.length > 0 || /\bimport\s/.test(skill.code)
    const isJs = (skill.language ?? 'javascript') === 'javascript'

    // Warm pool currently only supports JS simple mode (no third-party dependencies)
    // Module mode with imports or Python tools fall back to traditional deployment
    if (isJs && !hasImports) {
      const paramNames = Object.keys(
        (skill.parameters?.properties as Record<string, unknown>) ?? {}
      )
      const result = await allocateFromPool(skill.id, skill.code, 'simple', skill.envVars)
      if (result) {
        logger.info(`Skill ${skill.name} deployed successfully via warm pool: ${result.endpoint}`)
        return { endpoint: result.endpoint, nodePort: result.nodePort }
      }
      logger.info('Warm pool has no idle pods, falling back to traditional deployment')
    }
  }

  // --- Traditional deployment method ---
  const name = sanitizeName(skill.id)

  // 1. ConfigMap
  const cmPath = `/api/v1/namespaces/${K8S_NAMESPACE}/configmaps`
  await applyResource(cmPath, buildConfigMap(skill), `ConfigMap/${name}`)

  // 2. Deployment
  const depPath = `/apis/apps/v1/namespaces/${K8S_NAMESPACE}/deployments`
  await applyResource(depPath, buildDeployment(skill), `Deployment/${name}`)

  // 3. Service
  const svcPath = `/api/v1/namespaces/${K8S_NAMESPACE}/services`
  const svcRes = await k8sApi(svcPath, { method: 'POST', body: buildService(skill) })
  let nodePort: number
  if (svcRes.ok) {
    const svc = (await svcRes.json()) as { spec: { ports: { nodePort: number }[] } }
    nodePort = svc.spec.ports[0].nodePort
  } else {
    const existRes = await k8sApi(`${svcPath}/${name}`, { method: 'GET' })
    if (!existRes.ok) {
      throw new Error('Unable to get service info')
    }
    const exist = (await existRes.json()) as { spec: { ports: { nodePort: number }[] } }
    nodePort = exist.spec.ports[0].nodePort
  }

  const endpoint = `http://${K8S_NODE_IP}:${nodePort}`
  logger.info(`Skill ${skill.name} deployed successfully (traditional method): ${endpoint}`)
  return { endpoint, nodePort }
}

/** Stable string hash used to derive deterministic mock node ports. */
function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/** Undeploy: prefer recycling to warm pool, otherwise delete K8S resources */
export async function undeploySkill(skillId: string): Promise<void> {
  if (isK8sMockMode()) {
    logger.info(`K8S_MOCK: pretending to undeploy skill ${skillId}`)
    return
  }
  // Try recycling from warm pool
  if (isWarmPoolEnabled()) {
    const assigned = await findAssignedPod(skillId)
    if (assigned) {
      await recycleToPool(skillId)
      logger.info(`Skill ${skillId} recycled to warm pool`)
      return
    }
  }

  // Undeploy traditional deployment: delete all resources
  const name = sanitizeName(skillId)
  await deleteResource(`/api/v1/namespaces/${K8S_NAMESPACE}/services`, name)
  await deleteResource(`/apis/apps/v1/namespaces/${K8S_NAMESPACE}/deployments`, name)
  await deleteResource(`/api/v1/namespaces/${K8S_NAMESPACE}/configmaps`, name)

  logger.info(`Skill ${skillId} undeployed`)
}

/** Check deployment status (whether Pod is Ready) */
export async function getDeployStatus(skillId: string): Promise<{
  ready: boolean
  replicas: number
  readyReplicas: number
}> {
  if (isK8sMockMode()) {
    return { ready: true, replicas: 1, readyReplicas: 1 }
  }
  const name = sanitizeName(skillId)
  const res = await k8sApi(`/apis/apps/v1/namespaces/${K8S_NAMESPACE}/deployments/${name}`, {
    method: 'GET',
  })
  if (!res.ok) {
    return { ready: false, replicas: 0, readyReplicas: 0 }
  }
  const dep = (await res.json()) as {
    status?: { replicas?: number; readyReplicas?: number }
  }
  const replicas = dep.status?.replicas ?? 0
  const readyReplicas = dep.status?.readyReplicas ?? 0
  return { ready: readyReplicas > 0, replicas, readyReplicas }
}
