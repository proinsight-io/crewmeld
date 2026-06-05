import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'http'
import https from 'https'
import { createLogger } from '@crewmeld/logger'
import { readManifestFromTool } from '@/lib/dev-studio/manifest-reader'
import { applyManifestDefaults } from '@/lib/dev-studio/package-defaults'
import { paths } from '@/lib/dev-studio/paths'
import {
  buildJsResolvePrelude,
  buildPyResolvePrelude,
  extractParamResolution,
  type ParamResolution,
} from '@/lib/tools/param-resolution'
import type { SkillLanguage, SkillPackage } from '@/app/(employee)/skills/types'
import { buildRcloneSidecarSpec, SKILL_WORKSPACE_PATH } from './rclone-sidecar'
import { allocateFromPool, findAssignedPod, isWarmPoolEnabled, recycleToPool } from './warm-pool'

/**
 * Name of the shared PVC mounted at /workspace inside every tool pod that
 * touches files. Must be RWO-or-RWX depending on cluster topology —
 * single-node k3s with local-path is sufficient; multi-node requires an
 * RWX StorageClass (NFS / Longhorn / etc). The rclone-sync sidecar mounts
 * the same PVC and handles all MinIO ↔ PVC bytes movement.
 */
const SOP_WORKSPACE_PVC = process.env.K8S_SOP_WORKSPACE_PVC ?? 'crewmeld-sop-workspace'

/** Mount path matching SKILL_WORKSPACE_PATH in rclone-sidecar.ts. */
const SOP_WORKSPACE_MOUNT_PATH = SKILL_WORKSPACE_PATH

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
import { readFileSync, mkdirSync } from 'fs';
import { createServer } from 'http';

const toolCode = readFileSync('/app/tool.js', 'utf-8');

// Identifier-shaped param names only. Internal SOP_* fields (with
// underscore prefix) are extracted before this validation so the regex
// never sees them.
const SAFE_IDENT = /^[\\p{L}_$][\\p{L}\\p{N}_$]*$/u;
const SOP_WORKSPACE = process.env.SOP_WORKSPACE || '/workspace';
const RCLONE_RCD_URL = process.env.RCLONE_RCD_URL || 'http://127.0.0.1:5572';

// ---------------------------------------------------------------------------
// MinIO ↔ PVC sync via the rclone-sync sidecar's rcd HTTP API.
// The skill container never speaks S3 itself; it just asks rclone to copy
// minio:{bucket}/sop/{execId}/ ↔ /workspace/{execId}/. rclone handles
// incremental transfers (same-size/mtime files are skipped).
// ---------------------------------------------------------------------------
async function __rcloneCopy__(srcFs, dstFs) {
  try {
    const res = await fetch(RCLONE_RCD_URL + '/sync/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srcFs, dstFs }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      process.stderr.write('[rclone-sync] ' + srcFs + ' -> ' + dstFs + ' HTTP ' + res.status + ': ' + txt.slice(0, 300) + '\\n');
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write('[rclone-sync] ' + srcFs + ' -> ' + dstFs + ' failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
    return false;
  }
}
async function sopWorkspaceSyncIn(workdir, execId) {
  const bucket = process.env.MINIO_BUCKET || 'tool-files';
  await __rcloneCopy__('minio:' + bucket + '/sop/' + execId + '/', workdir);
}
async function sopWorkspaceSyncOut(workdir, execId) {
  const bucket = process.env.MINIO_BUCKET || 'tool-files';
  await __rcloneCopy__(workdir, 'minio:' + bucket + '/sop/' + execId + '/');
}

// Per-request: derive the execution-scoped working directory from the
// orchestrator-injected _sopExecutionId field. The PVC-backed model uses a
// single flat directory per SOP execution — inputs and outputs share the
// same directory. SOP_INPUT_DIR and SOP_OUTPUT_DIR are kept as aliases of
// SOP_WORKDIR so existing tool code keeps working without changes.
function applySopExecutionContext(params) {
  const execId = params._sopExecutionId;
  const urlPrefix = params._sopFileUrlPrefix;
  delete params._sopExecutionId;
  delete params._sopFileUrlPrefix;
  if (!execId) return { execId: null };
  const workdir = SOP_WORKSPACE + '/' + execId;
  process.env.SOP_EXECUTION_ID = execId;
  process.env.SOP_WORKDIR = workdir;
  process.env.SOP_INPUT_DIR = workdir;
  process.env.SOP_OUTPUT_DIR = workdir;
  if (urlPrefix) process.env.SOP_FILE_URL_PREFIX = urlPrefix;
  try { mkdirSync(workdir, { recursive: true }); } catch {}
  return {
    execId,
    workdir,
    sopEnv: {
      SOP_EXECUTION_ID: execId,
      SOP_WORKDIR: workdir,
      SOP_INPUT_DIR: workdir,
      SOP_OUTPUT_DIR: workdir,
      SOP_FILE_URL_PREFIX: urlPrefix || '',
      SOP_WORKSPACE,
    },
  };
}

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

  // Extract internal SOP_* fields before identifier validation — they
  // start with '_' and are not exposed to the tool author.
  const sopContext = applySopExecutionContext(bodyParams);
  const sopEnv = sopContext.sopEnv || {};

  // Pull MinIO objects into the local PVC dir BEFORE the tool runs.
  // rclone copy is incremental: files already in PVC with same size/mtime
  // are skipped, so subsequent calls in the same SOP are nearly free.
  if (sopContext.execId) {
    await sopWorkspaceSyncIn(sopContext.workdir, sopContext.execId);
  }

  // Validate body keys before merge (preset/env keys came through generation-time validation)
  for (const key of Object.keys(bodyParams)) {
    if (!SAFE_IDENT.test(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid param name: ' + key }));
      return;
    }
  }
  const params = Object.assign({}, __baseParams__, bodyParams, sopEnv);
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
    // Push new / modified workdir files back to MinIO so the SOP completion
    // flow and the next tool in the chain see them at sop/{execId}/{name}.
    if (sopContext.execId) {
      await sopWorkspaceSyncOut(sopContext.workdir, sopContext.execId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, result: result ?? null }));
  } catch (err) {
    if (sopContext.execId) {
      try { await sopWorkspaceSyncOut(sopContext.workdir, sopContext.execId); } catch {}
    }
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
import { mkdirSync } from 'fs';
import { run } from './tool.mjs';

const SOP_WORKSPACE = process.env.SOP_WORKSPACE || '/workspace';
const RCLONE_RCD_URL = process.env.RCLONE_RCD_URL || 'http://127.0.0.1:5572';

// ---------------------------------------------------------------------------
// MinIO ↔ PVC sync via rclone-sync sidecar (see JS_SERVER_SIMPLE).
// ---------------------------------------------------------------------------
async function __rcloneCopy__(srcFs, dstFs) {
  try {
    const res = await fetch(RCLONE_RCD_URL + '/sync/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srcFs, dstFs }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      process.stderr.write('[rclone-sync] ' + srcFs + ' -> ' + dstFs + ' HTTP ' + res.status + ': ' + txt.slice(0, 300) + '\\n');
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write('[rclone-sync] ' + srcFs + ' -> ' + dstFs + ' failed: ' + (err && err.message ? err.message : String(err)) + '\\n');
    return false;
  }
}
async function sopWorkspaceSyncIn(workdir, execId) {
  const bucket = process.env.MINIO_BUCKET || 'tool-files';
  await __rcloneCopy__('minio:' + bucket + '/sop/' + execId + '/', workdir);
}
async function sopWorkspaceSyncOut(workdir, execId) {
  const bucket = process.env.MINIO_BUCKET || 'tool-files';
  await __rcloneCopy__(workdir, 'minio:' + bucket + '/sop/' + execId + '/');
}

// Flat workspace dir: SOP_INPUT_DIR == SOP_OUTPUT_DIR == SOP_WORKDIR
// == /workspace/{execId}. Returns the execId + workdir so the caller
// can run sync_in / sync_out around the tool invocation.
function applySopExecutionContext(params) {
  const execId = params._sopExecutionId;
  const urlPrefix = params._sopFileUrlPrefix;
  delete params._sopExecutionId;
  delete params._sopFileUrlPrefix;
  if (!execId) return { execId: null };
  const workdir = SOP_WORKSPACE + '/' + execId;
  process.env.SOP_EXECUTION_ID = execId;
  process.env.SOP_WORKDIR = workdir;
  process.env.SOP_INPUT_DIR = workdir;
  process.env.SOP_OUTPUT_DIR = workdir;
  if (urlPrefix) process.env.SOP_FILE_URL_PREFIX = urlPrefix;
  try { mkdirSync(workdir, { recursive: true }); } catch {}
  params.SOP_EXECUTION_ID = execId;
  params.SOP_WORKDIR = workdir;
  params.SOP_INPUT_DIR = workdir;
  params.SOP_OUTPUT_DIR = workdir;
  params.SOP_FILE_URL_PREFIX = urlPrefix || '';
  params.SOP_WORKSPACE = SOP_WORKSPACE;
  return { execId, workdir };
}

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
  const sopCtx = applySopExecutionContext(params);

  if (sopCtx.execId) {
    await sopWorkspaceSyncIn(sopCtx.workdir, sopCtx.execId);
  }

  try {
    const result = await run(params);
    if (sopCtx.execId) {
      await sopWorkspaceSyncOut(sopCtx.workdir, sopCtx.execId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // If tool returns object with success, pass through directly (supports files and other fields)
    if (result && typeof result === 'object' && 'success' in result) {
      res.end(JSON.stringify(result));
    } else {
      res.end(JSON.stringify({ success: true, result: result ?? null }));
    }
  } catch (err) {
    if (sopCtx.execId) {
      try { await sopWorkspaceSyncOut(sopCtx.workdir, sopCtx.execId); } catch {}
    }
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

import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# MinIO ↔ PVC sync via the rclone-sync sidecar's rcd HTTP API.
# The skill container never speaks S3 directly; it asks rclone to copy
# minio:{bucket}/sop/{execId}/ ↔ /workspace/{execId}/. rclone handles
# incremental transfers (same-size/mtime files are skipped) and retries.
# ---------------------------------------------------------------------------

RCLONE_RCD_URL = os.environ.get('RCLONE_RCD_URL', 'http://127.0.0.1:5572')

def _rclone_copy(src_fs, dst_fs):
    payload = json.dumps({'srcFs': src_fs, 'dstFs': dst_fs}).encode('utf-8')
    req = urllib.request.Request(
        RCLONE_RCD_URL + '/sync/copy',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as e:
        body = ''
        try: body = e.read().decode('utf-8', errors='replace')[:300]
        except Exception: pass
        sys.stderr.write('[rclone-sync] ' + src_fs + ' -> ' + dst_fs + ' HTTP ' + str(e.code) + ': ' + body + '\\n')
        return False
    except Exception as e:
        sys.stderr.write('[rclone-sync] ' + src_fs + ' -> ' + dst_fs + ' failed: ' + str(e) + '\\n')
        return False

def sop_workspace_sync_in(workdir, exec_id):
    bucket = os.environ.get('MINIO_BUCKET', 'tool-files')
    _rclone_copy('minio:' + bucket + '/sop/' + exec_id + '/', workdir)

def sop_workspace_sync_out(workdir, exec_id):
    bucket = os.environ.get('MINIO_BUCKET', 'tool-files')
    _rclone_copy(workdir, 'minio:' + bucket + '/sop/' + exec_id + '/')

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
            # Extract orchestrator-injected SOP context. Each request brings
            # its own execution-scoped working directory; subprocess env
            # isolation guarantees no leakage across concurrent requests.
            # Flat layout: SOP_INPUT_DIR == SOP_OUTPUT_DIR == SOP_WORKDIR.
            exec_id = params.pop('_sopExecutionId', None)
            url_prefix = params.pop('_sopFileUrlPrefix', None)
            workspace = os.environ.get('SOP_WORKSPACE', '/workspace')
            sop_env = {}
            workdir = None
            if exec_id:
                workdir = workspace + '/' + exec_id
                sop_env['SOP_EXECUTION_ID'] = exec_id
                sop_env['SOP_WORKDIR'] = workdir
                sop_env['SOP_INPUT_DIR'] = workdir
                sop_env['SOP_OUTPUT_DIR'] = workdir
                if url_prefix:
                    sop_env['SOP_FILE_URL_PREFIX'] = url_prefix
                try:
                    os.makedirs(workdir, exist_ok=True)
                except Exception:
                    pass
                # Ask rclone-sync sidecar to pull MinIO sop/{execId}/ into
                # the local PVC dir. Incremental copy: files already present
                # with same size/mtime are skipped.
                sop_workspace_sync_in(workdir, exec_id)
            # Execute tool.py in a subprocess — fully isolated Python environment, free to import
            env = {**os.environ, **sop_env, '__TOOL_PARAMS__': json.dumps(params)}
            proc = subprocess.run(
                [sys.executable, '/app/tool.py'],
                capture_output=True, text=True, timeout=60, env=env
            )
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()
            if proc.returncode != 0:
                # Even on failure, push whatever the tool managed to write so
                # operators can inspect partial output via the MinIO proxy.
                if workdir and exec_id:
                    sop_workspace_sync_out(workdir, exec_id)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': stderr or stdout or 'exit code ' + str(proc.returncode)}).encode())
                return
            # Ask rclone-sync sidecar to push new / modified workdir files
            # back to MinIO before returning so downstream tools see them.
            if workdir and exec_id:
                sop_workspace_sync_out(workdir, exec_id)
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
    // Only hoist **top-level** import / from statements. Indented imports
    // (typically inside try/except blocks for optional-dependency fallback)
    // must stay in their original location — hoisting them would trigger an
    // unhandled ImportError before the fallback's pip install runs.
    if (/^(import\s|from\s)/.test(line)) {
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
function wrapAsEsmModule(code: string, paramNames: string[], resolution: ParamResolution): string {
  const lines = code.split('\n')
  const imports: string[] = []
  const body: string[] = []
  for (const line of lines) {
    // Only hoist top-level imports (same reason as wrapPyToolCode):
    // an indented `import` inside a try/catch is part of a fallback and
    // must stay there, not be lifted above the catch.
    if (/^(import\s|import\{)/.test(line)) {
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
      // Simple mode: new Function sandbox execution. defaults.json carries
      // the preset/envMap/types bundle; server.mjs reads it once at boot.
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
    '  pip install -r /app/requirements.txt --target "/cache/pip-lib/$DEPS_HASH" --cache-dir /cache/pip -i https://pypi.tuna.tsinghua.edu.cn/simple --extra-index-url https://mirrors.aliyun.com/pypi/simple --trusted-host pypi.tuna.tsinghua.edu.cn --trusted-host mirrors.aliyun.com --default-timeout 120 --retries 5 2>&1',
    'fi',
    'export PYTHONPATH="/cache/pip-lib/$DEPS_HASH:$PYTHONPATH"',
    'exec python /app/server.py',
  ].join('\n')

  const baseCommand = isJs
    ? hasJsDeps
      ? ['sh', '-c', npmInstallCmd]
      : ['node', '--experimental-fetch', '/app/server.mjs']
    : ['sh', '-c', pipInstallCmd]

  // Tool pods that touch SOP files mount the shared workspace PVC at
  // /workspace AND get an rclone-sync sidecar that handles MinIO ↔ PVC
  // copy on request. The server wrapper triggers sync via HTTP calls to
  // 127.0.0.1:5572 — it never touches MinIO directly.
  const mount = skill.needsFileMount === true ? buildRcloneSidecarSpec() : null

  logger.info(`Building deployment for ${skill.name}`, {
    skillId: skill.id,
    needsFileMount: mount !== null,
    containerCount: mount ? 2 : 1,
  })

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
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', 'cp -rL /code-ro/. /app/'],
              volumeMounts: [
                { name: 'code-ro', mountPath: '/code-ro' },
                { name: 'app', mountPath: '/app' },
              ],
            },
          ],
          containers: [
            ...(mount ? [mount.sidecarContainer] : []),
            {
              name: 'skill',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: baseCommand,
              ports: [{ containerPort: 3000 }],
              volumeMounts: [
                { name: 'app', mountPath: '/app' },
                { name: 'deps-cache', mountPath: '/cache' },
                ...(!isJs
                  ? [
                      {
                        name: 'deps-cache',
                        mountPath: '/root/.cache/ms-playwright',
                        subPath: 'playwright-browsers',
                      },
                    ]
                  : []),
                ...(mount ? [mount.skillVolumeMount] : []),
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
                ...(mount ? mount.skillEnv : []),
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
            { name: 'code-ro', configMap: { name } },
            { name: 'app', emptyDir: {} },
            { name: 'deps-cache', persistentVolumeClaim: { claimName: 'crewmeld-deps-cache' } },
            ...(mount
              ? [
                  {
                    name: 'sop-workspace',
                    persistentVolumeClaim: { claimName: SOP_WORKSPACE_PVC },
                  },
                ]
              : []),
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
// Dev-studio tool deployment via OpenSandbox (source === 'dev-studio')
// ---------------------------------------------------------------------------
//
// After the NFS migration (spec 2026-05-28 §11.1/§11.2) tool code lives at
// `paths.toolCode.forBff(toolId)` and shared Python deps live at
// `paths.sharedLibs.forBff()`. Deployment no longer downloads zip bytes,
// builds local-dev workarounds, or snapshots a template sandbox — it just
// validates the on-disk artifacts and (for service kind) starts a persistent
// sandbox with NFS volumes mounted in.

/** Long-lived sandbox TTL: 30 days. Deployed services stay up until explicit undeploy. */
/** undefined = manual cleanup mode (no TTL, container lives until explicit destroy) */
const DEPLOY_SANDBOX_TIMEOUT_SECONDS: number | undefined = undefined

/**
 * Poll a port inside a sandbox via Python socket probe until it responds or deadline passes.
 */
async function waitForPort(
  client: {
    exec: (args: {
      sandboxId: string
      cmd: string[]
      timeoutMs: number
    }) => Promise<{ exitCode: number }>
  },
  sandboxId: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const probeCmd = `python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('localhost',${port})); s.close()"`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await client.exec({
        sandboxId,
        cmd: ['bash', '-c', probeCmd],
        timeoutMs: 5_000,
      })
      if (res.exitCode === 0) return true
    } catch {
      // probe failed -- keep retrying
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Result for service-type dev-studio tool (long-lived container with HTTP endpoint). */
interface CmtoolServiceResult {
  kind: 'service'
  endpoint: string
  nodePort: number
  sandboxId: string
  useProxy: boolean
}

/**
 * Result for script-type dev-studio tool.
 *
 * No persistent sandbox: invoke creates an ephemeral container per call,
 * mounting tool code + shared site-packages from NFS. The invoke route reads
 * the manifest itself from NFS, so deploy returns no snapshot payload.
 */
interface CmtoolScriptResult {
  kind: 'script'
}

type CmtoolDeployResult = CmtoolServiceResult | CmtoolScriptResult

/**
 * Deploy a dev-studio (source === 'dev-studio') tool via OpenSandbox.
 *
 * - kind=service: long-lived sandbox with NFS volumes mounted; `init.sh` runs
 *   once (pip install is a no-op because the shared-libs prewarmer has
 *   already populated `paths.sharedLibs`), then `start.sh` is launched via
 *   nohup and we wait for the configured port.
 * - kind=script:  no container created at deploy time. Validate that
 *   `start.sh` exists on NFS and that the shared-libs cache contains the
 *   manifest's declared libraries. Invoke creates an ephemeral container per
 *   call (see `app/api/tools/[instanceId]/invoke/route.ts`).
 */
async function deployCmtoolSkill(skill: SkillPackage): Promise<CmtoolDeployResult> {
  // Code on NFS lives under the tool TEMPLATE id, not the instance id. When
  // deploying an instance, the route passes `templateId` separately; fall back
  // to `id` for backwards compat with callers that haven't been migrated yet.
  const toolId = skill.templateId ?? skill.id
  const codeDir = paths.toolCode.forBff(toolId)
  try {
    await fs.access(path.join(codeDir, 'start.sh'))
  } catch {
    throw new Error(
      `Tool code missing or incomplete on NFS for tool ${toolId}: ` +
        `${path.join(codeDir, 'start.sh')} not found. Re-run adopt to sync the workspace.`
    )
  }

  const manifest = await readManifestFromTool(toolId)
  if (!manifest) {
    throw new Error(
      `Manifest missing on NFS for tool ${toolId} ` +
        `(expected at ${path.join(codeDir, '.crewmeld-studio/manifest.json')}).`
    )
  }
  const withDefaults = applyManifestDefaults(manifest)

  if (isK8sMockMode()) {
    const mockPort = 30000 + (Math.abs(hashString(skill.id)) % 1000)
    logger.info(`K8S_MOCK: returning fake endpoint for dev-studio skill ${skill.id}`)
    if (withDefaults.kind === 'script') {
      return { kind: 'script' }
    }
    return {
      kind: 'service',
      endpoint: `http://mock-k8s:${mockPort}`,
      nodePort: mockPort,
      sandboxId: 'mock-sandbox',
      useProxy: false,
    }
  }

  const { getOpenSandboxClient } = await import('@/lib/dev-studio/opensandbox-client')
  const { DEFAULT_IMAGE } = await import('@/lib/dev-studio/package-defaults')
  const { buildToolNetworkPolicy } = await import('@/lib/dev-studio/network-policy-builder')
  const { getSandboxSettings } = await import('@/lib/sandbox/settings')

  const image = withDefaults.image ?? DEFAULT_IMAGE
  const resourceLimits = withDefaults.resources?.limits ?? {
    cpu: '500m',
    memory: '512Mi',
    'ephemeral-storage': '1Gi',
  }

  // Script-type: nothing to start at deploy time. Confirm shared-libs is
  // prewarmed so invoke does not have to pay pip install cost.
  if (withDefaults.kind === 'script') {
    const requiredLibs = manifest.dependencies.libraries
    if (requiredLibs.length > 0) {
      const sharedLibsDir = paths.sharedLibs.forBff()
      try {
        const entries = await fs.readdir(sharedLibsDir)
        if (entries.length === 0) {
          throw new Error(
            `shared-libs site-packages is empty at ${sharedLibsDir}; ` +
              `prewarmer must run before deploying script-type tool ${skill.id}.`
          )
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        throw new Error(
          `Cannot read shared-libs site-packages at ${sharedLibsDir}: ${detail}. ` +
            `Run dependency prewarmer for skill ${skill.id}.`
        )
      }
    }
    logger.info('Script-type dev-studio tool deployed (NFS volumes, no persistent sandbox)', {
      skillId: skill.id,
      libraries: requiredLibs.length,
    })
    return { kind: 'script' }
  }

  // Service-type: build env, egress, then create persistent sandbox with NFS volumes.
  const servicePort = withDefaults.service?.port ?? 3000
  const client = getOpenSandboxClient()

  const envVars: Record<string, string> = {}
  if (manifest.env?.properties) {
    for (const [k, prop] of Object.entries(manifest.env.properties)) {
      if (prop.default !== undefined && prop.default !== null) {
        envVars[k] = String(prop.default)
      }
    }
  }
  if (skill.envVars) {
    for (const e of skill.envVars) {
      envVars[e.name] = String(e.value ?? '')
    }
  }

  const pipIndexUrl = process.env.CREWMELD_SANDBOX_PIP_INDEX ?? ''
  const sandboxEnv: Record<string, string> = {
    ...envVars,
    // Make the prewarmed shared site-packages visible to `python` and `init.sh`
    // so pip install becomes a no-op even when manifest authors leave it in.
    PYTHONPATH: '/shared/site-packages',
    // Console_scripts from `pip install --target` (uvicorn, gunicorn, ...)
    // live in `/shared/site-packages/bin`. Without this prefix start.sh's
    // `exec uvicorn ...` dies with "uvicorn: not found" — same fix as the
    // run-test sandbox in sandbox-loader.ts.
    PATH: '/shared/site-packages/bin:/usr/local/bin:/usr/bin:/bin',
    ...(pipIndexUrl ? { PIP_INDEX_URL: pipIndexUrl } : {}),
  }

  // Network policy follows the admin global egress mode (Model A): unrestricted
  // → reach anything; allowlist → deny-default with manifest domains ∪ admin
  // global allow-lists ∪ pypi mirrors (kept for the occasional manifest dep the
  // prewarmer could not cache) ∪ CREWMELD_SANDBOX_SYSTEM_EGRESS.
  const pypiDomains = [
    'pypi.org',
    'files.pythonhosted.org',
    'pypi.tuna.tsinghua.edu.cn',
    'mirrors.aliyun.com',
  ]
  const sandboxSettings = await getSandboxSettings()
  const deployNetworkPolicy = buildToolNetworkPolicy(
    sandboxSettings.egressMode,
    manifest.dependencies.domains,
    {
      extraDomains: pypiDomains,
      globalDomains: sandboxSettings.allowedDomains,
      globalIps: sandboxSettings.allowedIps,
      toolIps: manifest.dependencies.ips,
    }
  )

  const volumes = [
    {
      name: 'shared-libs',
      hostPath: paths.sharedLibs.forSandbox(),
      mountPath: '/shared/site-packages',
      readOnly: true,
    },
    {
      name: 'tool-code',
      hostPath: paths.toolCode.forSandbox(toolId),
      mountPath: '/root/workspace',
      readOnly: false,
    },
    // Unified file IO contract: long-lived service pod mounts the sop-files
    // ROOT and tool code joins `_sopExecutionId` from each request body to
    // navigate to the per-SOP subdir at `/root/io/<sopExecId>/<filename>`.
    // The intent-router (lib/sop/llm-tool-executor.ts) injects the id; the
    // BFF mkdirs `<volume>/sop-files/<Y>/<M>/<D>/<sopExecId>/` at SOP start
    // and seeds conversation uploads into it. Same dir is served back to
    // the operator via /api/employee/tool-execution/<sopExecId>/files/<name>.
    {
      name: 'sop-files',
      hostPath: paths.sopFiles.forSandbox(),
      mountPath: '/root/io',
      readOnly: false,
    },
  ]

  const createParams = {
    image,
    entrypoint: ['sleep', 'infinity'],
    resourceLimits,
    timeoutSeconds: DEPLOY_SANDBOX_TIMEOUT_SECONDS,
    env: sandboxEnv,
    volumes,
    networkPolicy: deployNetworkPolicy,
    metadata: {
      'crewmeld.purpose': 'deploy',
      'crewmeld.skill-id': skill.id,
      'crewmeld.skill-name': skill.name,
    },
  }
  logger.info('Creating deploy sandbox for dev-studio service tool', {
    skillId: skill.id,
    image,
    servicePort,
  })

  let sandbox: { id: string }
  try {
    sandbox = await client.createSandbox(createParams)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    logger.error('createSandbox failed for dev-studio deploy', { skillId: skill.id, detail, stack })
    throw new Error(`Create sandbox failed: ${detail}`)
  }

  await client.waitUntilRunning(sandbox.id, { timeoutMs: 60_000, intervalMs: 500 })

  // Run init.sh only. Dependencies are NOT pip-installed here: declared libs
  // are prewarmed into the shared site-packages volume (mounted read-only at
  // /shared/site-packages, exposed via PYTHONPATH above). A pip install here is
  // redundant AND fails outright in the no-DNS runtime sandbox — pip still
  // contacts the index to resolve requirements even when the packages are
  // importable via PYTHONPATH (it tracks its own site-packages metadata, not
  // arbitrary PYTHONPATH dirs). init.sh handles only non-pip one-time setup.
  const initRes = await client.exec({
    sandboxId: sandbox.id,
    cmd: ['bash', '-c', 'set -e; cd /root/workspace; [ -f init.sh ] && bash init.sh; true'],
    timeoutMs: 300_000,
  })
  if (initRes.exitCode !== 0) {
    await client.destroy(sandbox.id).catch(() => {})
    throw new Error(`init failed (exit ${initRes.exitCode}): ${initRes.stderr || initRes.stdout}`)
  }

  // Service-type: start the long-running HTTP service
  await client.exec({
    sandboxId: sandbox.id,
    cmd: [
      'bash',
      '-c',
      'cd /root/workspace && nohup bash start.sh > /tmp/dev-studio-service.log 2>&1 &',
    ],
    timeoutMs: 5_000,
  })

  const portReady = await waitForPort(client, sandbox.id, servicePort, 30_000)
  if (!portReady) {
    let logTail = ''
    try {
      const tailRes = await client.exec({
        sandboxId: sandbox.id,
        cmd: ['tail', '-200', '/tmp/dev-studio-service.log'],
        timeoutMs: 5_000,
      })
      logTail = tailRes.stdout
    } catch {
      /* non-fatal */
    }
    await client.destroy(sandbox.id).catch(() => {})
    throw new Error(`Service did not start on port ${servicePort} within 30s.\n${logTail}`)
  }

  const baseEndpoint = await client.getEndpoint(sandbox.id, servicePort)
  const servicePath = withDefaults.service?.path ?? '/'
  const endpoint = `${baseEndpoint.replace(/\/$/, '')}${servicePath}`

  logger.info(`Skill ${skill.name} deployed via OpenSandbox: ${endpoint}`, {
    sandboxId: sandbox.id,
    servicePort,
    servicePath,
  })

  return {
    kind: 'service',
    endpoint,
    nodePort: servicePort,
    sandboxId: sandbox.id,
    useProxy: client.isProxyMode(),
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

/** Unified deploy result — callers check `deployType` to branch. */
export type DeploySkillResult =
  | { deployType: 'k8s'; endpoint: string; nodePort: number }
  | {
      deployType: 'opensandbox'
      endpoint: string
      nodePort: number
      sandboxId: string
      useProxy: boolean
    }
  | { deployType: 'opensandbox-script' }

/** Deploy skill to K8S or OpenSandbox depending on tool type. */
export async function deploySkill(skill: SkillPackage): Promise<DeploySkillResult> {
  // Route dev-studio tools to the NFS-mounted OpenSandbox deployment path.
  if (skill.source === 'dev-studio') {
    const r = await deployCmtoolSkill(skill)
    if (r.kind === 'script') {
      return { deployType: 'opensandbox-script' }
    }
    return {
      deployType: 'opensandbox',
      endpoint: r.endpoint,
      nodePort: r.nodePort,
      sandboxId: r.sandboxId,
      useProxy: r.useProxy,
    }
  }

  if (isK8sMockMode()) {
    const mockPort = 30000 + (Math.abs(hashString(skill.id)) % 1000)
    logger.info(`K8S_MOCK: returning fake endpoint for skill ${skill.id}`)
    return { deployType: 'k8s', endpoint: `http://mock-k8s:${mockPort}`, nodePort: mockPort }
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
        return { deployType: 'k8s', endpoint: result.endpoint, nodePort: result.nodePort }
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
  return { deployType: 'k8s', endpoint, nodePort }
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

// ---------------------------------------------------------------------------
// Shared helpers used by the mounted-skill code path.
// ---------------------------------------------------------------------------

/** ConfigMap data block — extracted so future callers can reuse the same
 *  wrapping logic without duplicating the JS/Python decision tree. */
function buildConfigMapData(skill: SkillPackage): Record<string, string> {
  const lang = skill.language ?? 'javascript'
  const isJs = lang === 'javascript'

  const jsDeps = isJs ? extractJsDeps(skill.code ?? '') : []
  const hasImports = jsDeps.length > 0 || /\bimport\s/.test(skill.code ?? '')

  const resolution = extractParamResolution(skill.parameters, skill.presetParams)

  if (isJs) {
    if (hasImports) {
      return {
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
    }
    return {
      'server.mjs': JS_SERVER_SIMPLE,
      'tool.js': skill.code ?? '',
      'defaults.json': JSON.stringify(resolution),
    }
  }

  return {
    'server.py': PY_SERVER_CODE,
    'tool.py': wrapPyToolCode(skill.code ?? '', resolution),
    'requirements.txt': extractPyDeps(skill.code ?? '').join('\n'),
  }
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
