/**
 * K8S warm pool management
 *
 * Pre-create N idle Pods (running universal server), inject code into a pool Pod when deploying tools,
 * achieve sub-second deployment. Recycle Pod to pool on undeploy (destroy if pool full).
 */

import http from 'http'
import https from 'https'
import { createLogger } from '@crewmeld/logger'

const logger = createLogger('K8sWarmPool')

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ''
const K8S_API_TOKEN = process.env.K8S_API_TOKEN ?? ''
const K8S_NAMESPACE = process.env.K8S_DEPLOY_NAMESPACE ?? 'crewmeld-skills'
const K8S_NODE_IP = process.env.K8S_NODE_IP ?? ''
const K8S_SKIP_TLS = process.env.K8S_SKIP_TLS_VERIFY === 'true'

/** Warm pool size, configured via environment variable */
const POOL_SIZE = Number(process.env.K8S_WARM_POOL_SIZE) || 3

const POOL_LABEL_APP = 'crewmeld-warm-pool'
// Pinned tag — see deploy-skill.ts IMAGE_MAP for rationale.
const POOL_IMAGE =
  process.env.K8S_WARM_POOL_IMAGE ??
  process.env.K8S_IMAGE_NODE ??
  'docker.io/library/node:22-bookworm'

// ---------------------------------------------------------------------------
// K8S API reuse (same request method as deploy-skill)
// ---------------------------------------------------------------------------

interface K8sResponse {
  ok: boolean
  status: number
  json: () => Promise<Record<string, unknown>>
  text: () => Promise<string>
}

function k8sApi(path: string, opts: { method: string; body?: unknown }): Promise<K8sResponse> {
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
// Universal Server code (injected into warm pool Pods)
// ---------------------------------------------------------------------------

const WARM_SERVER_CODE = `
import { createServer } from 'http';
import { createHash } from 'crypto';
import { writeFileSync, existsSync, mkdirSync, symlinkSync, readdirSync } from 'fs';
import { execFileSync, execSync, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCb);

let currentHandler = null;
let toolLoaded = false;
let toolEnvVars = {};
let pythonReady = false; // Whether Python runtime is installed (on-demand, cached after install)
let pythonInstalling = false; // Installation in progress (prevents re-entry)

// ---------------------------------------------------------------------------
// Helper: synchronous command execution (only for non-blocking quick operations)
// ---------------------------------------------------------------------------
function exec(cmd, args, opts) {
  return execFileSync(cmd, args, { timeout: 180000, stdio: 'pipe', ...opts }).toString();
}

function shellExec(cmdLine, opts) {
  return execSync(cmdLine, { timeout: 180000, stdio: 'pipe', ...opts }).toString();
}

// Async shell command execution (non-blocking, health check remains responsive)
async function shellExecAsync(cmdLine) {
  const { stdout } = await execFileAsync('sh', ['-c', cmdLine], { timeout: 300000 });
  return stdout;
}

// ---------------------------------------------------------------------------
// Helper: ensure Python runtime is available (async install, non-blocking)
// ---------------------------------------------------------------------------
async function ensurePython() {
  if (pythonReady) return;
  if (pythonInstalling) {
    while (pythonInstalling) await new Promise(r => setTimeout(r, 500));
    return;
  }
  pythonInstalling = true;
  console.log('Checking Python environment...');

  const PYTHON_TAR = '/cache/python-runtime.tar.gz';

  // Check if system already has python3 + pip (both required to be ready)
  let hasPython = false;
  try {
    exec('python3', ['--version']);
    exec('python3', ['-m', 'pip', '--version']);
    hasPython = true;
  } catch {}

  if (!hasPython) {
    // Try restoring from PVC cache (extract ~5s, 10x faster than apt-get ~60s)
    try {
      const tarExists = existsSync(PYTHON_TAR);
      console.log('python: PVC cache check:', tarExists ? 'found ' + PYTHON_TAR : 'not found');
      if (tarExists) {
        console.log('python: restoring from PVC cache...');
        const tarOutput = await shellExecAsync('tar xzf ' + PYTHON_TAR + ' -C / 2>&1 || echo TAR_FAILED');
        console.log('python: tar extract result:', tarOutput.trim().slice(0, 200));
        try {
          const pyVer = exec('python3', ['--version']).trim();
          console.log('python: python3 restored:', pyVer);
          const pipVer = exec('python3', ['-m', 'pip', '--version']).trim();
          console.log('python: pip restored:', pipVer);
          hasPython = true;
          console.log('python: restored from cache (verified).');
        } catch (verifyErr) {
          console.log('python: cache incomplete:', verifyErr.message || verifyErr);
          try { exec('rm', ['-f', PYTHON_TAR]); } catch {}
        }
      }
    } catch (cacheErr) {
      console.log('python: cache restore failed:', cacheErr.message || cacheErr);
      try { exec('rm', ['-f', PYTHON_TAR]); } catch {}
    }
  }

  if (!hasPython) {
    // Fresh install (slow ~60s, but only needed once, subsequent Pods restore from cache)
    console.log('python: cache miss, installing via apt-get...');
    try {
      await shellExecAsync('sed -i "s/deb.debian.org/mirrors.aliyun.com/g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i "s/deb.debian.org/mirrors.aliyun.com/g" /etc/apt/sources.list 2>/dev/null || true');
    } catch { /* ignore */ }
    await shellExecAsync('apt-get update -qq && apt-get install -y -qq python3-full python3-pip 2>&1 || apt-get install -y -qq python3 python3-pip 2>&1');
    exec('python3', ['--version']);
    exec('pip3', ['--version']);
    // Archive Python runtime to PVC (subsequent Pods restore in ~5s)
    console.log('python: caching to PVC...');
    try {
      // Archive all Python-related files: binaries, stdlib, dist-packages (incl. pip), pip entry scripts
      await shellExecAsync('tar czf ' + PYTHON_TAR + ' /usr/bin/python3* /usr/bin/pip* /usr/lib/python3* /usr/local/lib/python3* /usr/local/bin/pip* /usr/share/python3* 2>/dev/null || true');
      // Verify archive result
      try {
        const tarSize = exec('stat', ['-c', '%s', PYTHON_TAR]).trim();
        console.log('python: cached to PVC (' + (Number(tarSize) / 1024 / 1024).toFixed(1) + 'MB).');
      } catch {
        console.log('python: cached to PVC.');
      }
    } catch {
      console.log('python: cache write failed (non-critical).');
    }
  }

  // Set global pip mirror (via env vars, all subprocess pip installs use this mirror)
  process.env.PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
  process.env.PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn';

  pythonReady = true;
  pythonInstalling = false;
  console.log('Python environment ready.');
}

// ---------------------------------------------------------------------------
// Helper: ensure /app/package.json exists (required for npm install)
// ---------------------------------------------------------------------------
function ensurePackageJson() {
  if (!existsSync('/app/package.json')) {
    writeFileSync('/app/package.json', JSON.stringify({ type: 'commonjs' }));
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', loaded: toolLoaded }));
    return;
  }

  // Status query
  if (req.url === '/_status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loaded: toolLoaded, pythonReady }));
    return;
  }

  // -----------------------------------------------------------------------
  // Receive dependency packages uploaded by the server /_upload-modules
  // Server installs deps locally, then tar.gz archives and uploads to Pod for extraction
  // -----------------------------------------------------------------------
  if (req.url === '/_upload-modules' && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { tarball, language } = JSON.parse(body);
      if (!tarball) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      const { writeFileSync: wf } = await import('fs');
      const isPython = language === 'python';
      // Write temporary tar.gz file
      const tarPath = '/tmp/modules.tar.gz';
      wf(tarPath, Buffer.from(tarball, 'base64'));
      // Extract to /app
      if (isPython) {
        await ensurePython();
        mkdirSync('/app/pylibs', { recursive: true });
        exec('tar', ['xzf', tarPath, '-C', '/app/pylibs']);
      } else {
        mkdirSync('/app/node_modules', { recursive: true });
        exec('tar', ['xzf', tarPath, '-C', '/app']);
      }
      exec('rm', ['-f', tarPath]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Install dependencies inside Pod /_deps (fallback when server upload fails)
  // -----------------------------------------------------------------------
  if (req.url === '/_deps' && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { deps, language } = JSON.parse(body);
      if (!deps || deps.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, installed: [] }));
        return;
      }
      const isPython = language === 'python';
      const sorted = [...deps].sort();
      const hash = createHash('md5').update(sorted.join(',')).digest('hex');

      if (isPython) {
        await ensurePython();
        const cacheDir = '/cache/pip-lib/' + hash;
        if (existsSync(cacheDir) && readdirSync(cacheDir).length > 0) {
          console.log('pip: cache hit (' + hash + '), skipping install');
        } else {
          console.log('pip: cache miss (' + hash + '), installing...');
          mkdirSync(cacheDir, { recursive: true });
          exec('pip3', ['install', '--quiet', '--break-system-packages',
            '--target', cacheDir,
            '--cache-dir', '/cache/pip',
            '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
            '--extra-index-url', 'https://mirrors.aliyun.com/pypi/simple',
            '--trusted-host', 'pypi.tuna.tsinghua.edu.cn',
            '--trusted-host', 'mirrors.aliyun.com',
            '--default-timeout', '120',
            '--retries', '5',
            ...deps], { cwd: '/app' });
        }
        // Set PYTHONPATH so subsequent code can find installed packages
        process.env.PYTHONPATH = cacheDir + ':' + (process.env.PYTHONPATH || '');

        // Playwright browser cache: if playwright was installed, check browser cache, install if missing
        if (deps.includes('playwright')) {
          const browserCache = '/root/.cache/ms-playwright';
          const hasBrowser = existsSync(browserCache) &&
            readdirSync(browserCache).some(d => d.startsWith('chromium'));
          if (!hasBrowser) {
            console.log('playwright: browser cache miss, downloading chromium binary...');
            try {
              // Download browser binary only (without --with-deps), persist binary to PVC
              exec('python3', ['-m', 'playwright', 'install', 'chromium'], {
                env: { ...process.env },
              });
              console.log('playwright: chromium binary cached to PVC.');
            } catch (e) {
              console.warn('playwright: browser install failed:', e.message);
            }
          } else {
            console.log('playwright: browser binary cache hit, skipping download.');
          }
          // System shared libs (libnspr4, etc.) are at OS level, not persisted, must install on every Pod start
          console.log('playwright: installing system dependencies (libnspr4, libnss3, etc.)...');
          try {
            exec('python3', ['-m', 'playwright', 'install-deps', 'chromium'], {
              env: { ...process.env },
            });
            console.log('playwright: system dependencies installed.');
          } catch (e) {
            console.warn('playwright: install-deps failed (may be unsupported on this OS):', e.message);
          }
        }
      } else {
        const cacheDir = '/cache/npm-lib/' + hash;
        if (existsSync(cacheDir + '/node_modules')) {
          console.log('npm: cache hit (' + hash + '), linking...');
          try { exec('rm', ['-rf', '/app/node_modules']); } catch {}
          symlinkSync(cacheDir + '/node_modules', '/app/node_modules');
        } else {
          console.log('npm: cache miss (' + hash + '), installing...');
          ensurePackageJson();
          exec('npm', ['install', '--omit=dev', '--quiet',
            '--cache', '/cache/npm',
            '--registry', 'https://registry.npmmirror.com',
            ...deps], { cwd: '/app' });
          mkdirSync(cacheDir, { recursive: true });
          exec('cp', ['-r', '/app/node_modules', cacheDir + '/node_modules']);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, installed: deps, cacheHit: false }));
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().slice(0, 500) : err.message;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: msg }));
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Code injection /_inject
  // -----------------------------------------------------------------------
  if (req.url === '/_inject' && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { code, mode, envVars } = JSON.parse(body);
      toolEnvVars = envVars || {};

      // ---- Python mode ----
      if (mode === 'python') {
        await ensurePython();
        const lines = code.split('\\n');
        const paramKeys = Object.keys({}); // Params injected at execution time
        const script = [
          'import json, os, sys',
          '',
          '__params__ = json.loads(os.environ.get("__TOOL_PARAMS__", "{}"))',
          'for __k__, __v__ in __params__.items(): globals()[__k__] = __v__',
          '',
          'try:',
          ...lines.map(l => '    ' + l),
          '    print(json.dumps({"__result__": result if "result" in dir() else None}))',
          'except Exception as e:',
          '    print(json.dumps({"__error__": str(e)}))',
        ].join('\\n');
        writeFileSync('/app/tool.py', script);
        currentHandler = async (params) => {
          // Provide harmless defaults for SOP_* env so tools written
          // against the mounted-workspace contract (needsFileMount=true)
          // don't KeyError on os.environ['SOP_INPUT_DIR'] when run in
          // the test sandbox where no real mount exists.
          const sandboxSopEnv = {
            // Flat layout: SOP_WORKDIR is the single working dir; the older
            // SOP_INPUT_DIR / SOP_OUTPUT_DIR aliases point to the same place.
            SOP_WORKDIR: '/app/sandbox-workspace',
            SOP_INPUT_DIR: '/app/sandbox-workspace',
            SOP_OUTPUT_DIR: '/app/sandbox-workspace',
            SOP_EXECUTION_ID: 'sandbox-test',
            SOP_FILE_URL_PREFIX: '',
            SOP_WORKSPACE: '/app',
          };
          const output = exec('python3', ['/app/tool.py'], {
            cwd: '/app',
            timeout: 30000,
            // Merge PYTHONPATH: prioritize /_deps cached dir, append /app/pylibs (/_load tarball path)
            env: { ...process.env, ...sandboxSopEnv, ...toolEnvVars, __TOOL_PARAMS__: JSON.stringify(params), PYTHONPATH: (process.env.PYTHONPATH ? process.env.PYTHONPATH + ':' : '') + '/app/pylibs' },
          });
          const parsed = JSON.parse(output.trim() || '{}');
          if (parsed.__error__) throw new Error(parsed.__error__);
          return parsed.__result__;
        };
      }
      // ---- JS module mode (has import/require) - unified subprocess execution ----
      else if (mode === 'module') {
        // Separate import/require statements from business code
        const lines = code.split('\\n');
        const importLines = [];
        const bodyLines = [];
        for (const line of lines) {
          if (/^\\s*(import\\s|const\\s+.*=\\s*require\\s*\\()/.test(line)) {
            importLines.push(line);
          } else {
            bodyLines.push(line);
          }
        }
        // Determine ESM or CJS
        const hasESM = importLines.some(l => /^\\s*import\\s/.test(l));
        const ext = hasESM ? '.mjs' : '.cjs';
        const wrapperCode = [
          ...importLines,
          '',
          'const __params__ = JSON.parse(process.env.__TOOL_PARAMS__ || "{}");',
          'for (const [__k__, __v__] of Object.entries(__params__)) { globalThis[__k__] = __v__; }',
          '',
          '(async () => {',
          '  try {',
          ...bodyLines.map(l => '    ' + l),
          '  } catch (err) {',
          '    process.stdout.write(JSON.stringify({ __error__: err.message }));',
          '    process.exit(0);',
          '  }',
          '})().then((result) => {',
          '  process.stdout.write(JSON.stringify({ __result__: result ?? null }));',
          '}).catch((err) => {',
          '  process.stdout.write(JSON.stringify({ __error__: err.message }));',
          '});',
        ].join('\\n');
        writeFileSync('/app/tool' + ext, wrapperCode);
        currentHandler = async (params) => {
          // Same rationale as the Python branch: provide test-sandbox
          // defaults for SOP_* env so mount-mode tools don't crash on
          // process.env.SOP_INPUT_DIR access in test mode.
          const sandboxSopEnv = {
            // Flat layout: SOP_WORKDIR is the single working dir; the older
            // SOP_INPUT_DIR / SOP_OUTPUT_DIR aliases point to the same place.
            SOP_WORKDIR: '/app/sandbox-workspace',
            SOP_INPUT_DIR: '/app/sandbox-workspace',
            SOP_OUTPUT_DIR: '/app/sandbox-workspace',
            SOP_EXECUTION_ID: 'sandbox-test',
            SOP_FILE_URL_PREFIX: '',
            SOP_WORKSPACE: '/app',
          };
          const output = exec('node', ['/app/tool' + ext], {
            cwd: '/app',
            timeout: 30000,
            env: { ...process.env, ...sandboxSopEnv, ...toolEnvVars, __TOOL_PARAMS__: JSON.stringify(params) },
          });
          const parsed = JSON.parse(output.trim() || '{}');
          if (parsed.__error__) throw new Error(parsed.__error__);
          return parsed.__result__;
        };
      }
      // ---- JS simple mode (no import/require) ----
      else {
        writeFileSync('/app/tool.js', code);
        const toolCode = code;
        currentHandler = async (params) => {
          const paramKeys = Object.keys(params);
          const paramLines = paramKeys
            .map(k => 'const ' + k + ' = __params__[' + JSON.stringify(k) + '];')
            .join('\\n');
          // Merge Pod-level env vars (MINIO_*, etc.) with tool-level env vars
          const mergedEnv = {};
          for (const k of Object.keys(process.env)) {
            if (k.startsWith('MINIO_')) mergedEnv[k] = process.env[k];
          }
          Object.assign(mergedEnv, toolEnvVars);
          const envSetup = Object.keys(mergedEnv).length > 0
            ? 'const process = { env: __envVars__ };\\n'
            : 'const process = { env: {} };\\n';
          const wrapped = 'return (async () => {\\n' + envSetup + paramLines + '\\n' + toolCode + '\\n})();';
          const fn = new Function('__params__', 'fetch', '__envVars__', wrapped);
          return fn(params, globalThis.fetch, mergedEnv);
        };
      }

      toolLoaded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Reset (called on recycle)
  // -----------------------------------------------------------------------
  if (req.url === '/_reset' && req.method === 'POST') {
    currentHandler = null;
    toolLoaded = false;
    toolEnvVars = {};
    // Note: do not reset pythonReady - Python runtime remains available after install
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // -----------------------------------------------------------------------
  // Tool invocation POST /
  // -----------------------------------------------------------------------
  if (req.method === 'POST') {
    if (!currentHandler) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No tool loaded' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || '{}');
    try {
      const result = await currentHandler(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: result ?? null }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(3000, () => console.log('Warm pool server ready on :3000'));
`.trim()

// ---------------------------------------------------------------------------
// Pod resource building
// ---------------------------------------------------------------------------

function poolPodName(index: number): string {
  return `warm-pool-${index}`
}

function buildPoolPod(
  name: string,
  envVars?: Array<{ name: string; value: string }>
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: K8S_NAMESPACE,
      labels: {
        app: POOL_LABEL_APP,
        'pool-status': 'idle',
        'pod-name': name,
      },
    },
    spec: {
      containers: [
        {
          name: 'skill',
          image: POOL_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '--experimental-fetch', '/app/server.mjs'],
          ports: [{ containerPort: 3000 }],
          env: [
            ...(envVars ?? []).map((e) => ({ name: e.name, value: String(e.value ?? '') })),
            { name: 'MINIO_ENDPOINT', value: process.env.MINIO_ENDPOINT ?? '' },
            { name: 'MINIO_ACCESS_KEY', value: process.env.MINIO_ACCESS_KEY ?? '' },
            { name: 'MINIO_SECRET_KEY', value: process.env.MINIO_SECRET_KEY ?? '' },
            { name: 'MINIO_BUCKET', value: process.env.MINIO_BUCKET ?? 'tool-files' },
            { name: 'MINIO_PUBLIC_URL', value: process.env.MINIO_PUBLIC_URL ?? '' },
          ],
          volumeMounts: [
            { name: 'server', mountPath: '/app/server.mjs', subPath: 'server.mjs' },
            { name: 'deps-cache', mountPath: '/cache' },
          ],
          resources: {
            limits: { cpu: '200m', memory: '256Mi' },
            requests: { cpu: '50m', memory: '64Mi' },
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 3000 },
            initialDelaySeconds: 5,
            periodSeconds: 10,
          },
          readinessProbe: {
            httpGet: { path: '/health', port: 3000 },
            initialDelaySeconds: 3,
            periodSeconds: 5,
          },
        },
      ],
      volumes: [
        {
          name: 'server',
          configMap: { name: 'warm-pool-server' },
        },
        {
          name: 'deps-cache',
          persistentVolumeClaim: { claimName: 'crewmeld-deps-cache' },
        },
      ],
    },
  }
}

function buildPoolService(podName: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: podName,
      namespace: K8S_NAMESPACE,
      labels: { app: POOL_LABEL_APP, 'pool-pod': podName },
    },
    spec: {
      type: 'NodePort',
      selector: { app: POOL_LABEL_APP, 'pod-name': podName },
      ports: [{ port: 3000, targetPort: 3000 }],
    },
  }
}

// ---------------------------------------------------------------------------
// Pool internal HTTP calls (direct call via Pod IP)
// ---------------------------------------------------------------------------

async function podHttpCall(
  podIp: string,
  path: string,
  method: string,
  body?: unknown
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined
    const req = http.request(
      `http://${podIp}:3000${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: 10000,
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
      reject(new Error('Pod call timeout'))
    })
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

/** Quick health check: 3s timeout, confirm Pod reachable */
async function checkPodHealth(podIp: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `http://${podIp}:3000/health`,
      { method: 'GET', timeout: 3000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve((res.statusCode ?? 500) < 300)
        })
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/** Async destroy unhealthy Pod + Service and replenish pool */
function destroyBadPod(podName: string): void {
  ;(async () => {
    try {
      await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, { method: 'DELETE' })
      await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services/${podName}`, { method: 'DELETE' })
      logger.info(`Destroyed unhealthy pod ${podName}`)
    } catch (err) {
      logger.warn(
        `Failed to destroy pod ${podName}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    ensurePoolCapacity().catch(() => {})
  })()
}

// ---------------------------------------------------------------------------
// K8S Label operations
// ---------------------------------------------------------------------------

async function patchPodLabels(
  podName: string,
  labels: Record<string, string | null>
): Promise<void> {
  const patchBody = { metadata: { labels } }
  const res = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, {
    method: 'PATCH',
    body: patchBody,
  })
  // K8S PATCH needs special Content-Type, uses strategic merge patch
  // Simplified here: if PATCH not supported, use GET + PUT instead
  if (!res.ok) {
    // Fallback: read Pod, modify labels, PUT back
    const getRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, {
      method: 'GET',
    })
    if (!getRes.ok) throw new Error(`Failed to get pod ${podName}`)
    const pod = (await getRes.json()) as Record<string, unknown>
    const meta = pod.metadata as Record<string, unknown>
    const currentLabels = (meta.labels ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(labels)) {
      if (v === null) delete currentLabels[k]
      else currentLabels[k] = v
    }
    meta.labels = currentLabels
    const putRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, {
      method: 'PUT',
      body: pod,
    })
    if (!putRes.ok) {
      const err = await putRes.text()
      throw new Error(`Failed to update pod labels: ${err}`)
    }
  }
}

// ---------------------------------------------------------------------------
// List Pods in pool
// ---------------------------------------------------------------------------

interface PoolPodInfo {
  name: string
  ip: string
  status: 'idle' | 'assigned' | 'testing'
  skillId?: string
  nodePort?: number
}

async function listPoolPods(): Promise<PoolPodInfo[]> {
  const res = await k8sApi(
    `/api/v1/namespaces/${K8S_NAMESPACE}/pods?labelSelector=app=${POOL_LABEL_APP}`,
    { method: 'GET' }
  )
  if (!res.ok) return []

  const body = (await res.json()) as { items?: Array<Record<string, unknown>> }
  const pods: PoolPodInfo[] = []

  for (const item of body.items ?? []) {
    const meta = item.metadata as { name: string; labels?: Record<string, string> }
    const spec = item.status as { podIP?: string; phase?: string }
    if (spec?.phase !== 'Running') continue

    pods.push({
      name: meta.name,
      ip: spec.podIP ?? '',
      status: (meta.labels?.['pool-status'] as 'idle' | 'assigned' | 'testing') ?? 'idle',
      skillId: meta.labels?.['skill-id'],
    })
  }

  return pods
}

/** Get NodePort for Pod's corresponding Service */
async function getServiceNodePort(svcName: string): Promise<number | undefined> {
  const res = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services/${svcName}`, {
    method: 'GET',
  })
  if (!res.ok) return undefined
  const svc = (await res.json()) as { spec: { ports: { nodePort: number }[] } }
  return svc.spec?.ports?.[0]?.nodePort
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Whether warm pool is available */
export function isWarmPoolEnabled(): boolean {
  return Boolean(K8S_API_SERVER && K8S_API_TOKEN && POOL_SIZE > 0)
}

/** Initialize warm pool: create ConfigMap + N Pods + Services */
export async function initWarmPool(): Promise<void> {
  if (!isWarmPoolEnabled()) return

  logger.info(`Initializing warm pool, target size: ${POOL_SIZE}`)

  // Ensure namespace
  const nsRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}`, { method: 'GET' })
  if (!nsRes.ok) {
    logger.info(`Namespace ${K8S_NAMESPACE} not found, attempting to create...`)
    const nsCreateRes = await k8sApi('/api/v1/namespaces', {
      method: 'POST',
      body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: K8S_NAMESPACE } },
    })
    if (nsCreateRes.ok) {
      logger.info(`Namespace ${K8S_NAMESPACE} created successfully`)
    } else if (nsCreateRes.status === 403) {
      throw new Error(
        `Namespace ${K8S_NAMESPACE} does not exist and the current service account lacks permission to create it. Please have the cluster admin run: kubectl create namespace ${K8S_NAMESPACE}`
      )
    } else {
      const body = await nsCreateRes.text()
      throw new Error(
        `Failed to create namespace ${K8S_NAMESPACE} (${nsCreateRes.status}): ${body}`
      )
    }
  }

  // Create server ConfigMap
  const cmPath = `/api/v1/namespaces/${K8S_NAMESPACE}/configmaps`
  const cm = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'warm-pool-server', namespace: K8S_NAMESPACE },
    data: { 'server.mjs': WARM_SERVER_CODE },
  }
  const cmRes = await k8sApi(cmPath, { method: 'POST', body: cm })
  if (!cmRes.ok) {
    const cmBody = (await cmRes.json()) as { reason?: string }
    if (cmBody.reason === 'AlreadyExists') {
      await k8sApi(`${cmPath}/warm-pool-server`, { method: 'PUT', body: cm })
    }
  }

  // Check existing pool Pods
  const existing = await listPoolPods()
  const idleCount = existing.filter((p) => p.status === 'idle').length

  // Replenish insufficient Pods
  const toCreate = POOL_SIZE - idleCount
  if (toCreate <= 0) {
    logger.info(`Warm pool already has ${idleCount} idle pods, no creation needed`)
    return
  }

  // Find available index
  const existingNames = new Set(existing.map((p) => p.name))
  let created = 0
  for (let i = 0; created < toCreate && i < POOL_SIZE + 100; i++) {
    const name = poolPodName(i)
    if (existingNames.has(name)) continue

    // Create Pod
    const podRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods`, {
      method: 'POST',
      body: buildPoolPod(name),
    })
    if (!podRes.ok) {
      const podBody = (await podRes.json()) as { reason?: string }
      if (podBody.reason !== 'AlreadyExists') {
        logger.warn(`Failed to create warm pod ${name}: ${JSON.stringify(podBody)}`)
        continue
      }
    }

    // Create corresponding Service (one Service per Pod, exact match via pod-name label)
    const svc = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: K8S_NAMESPACE,
        labels: { app: POOL_LABEL_APP, 'pool-pod': name },
      },
      spec: {
        type: 'NodePort',
        selector: { app: POOL_LABEL_APP, 'pod-name': name },
        ports: [{ port: 3000, targetPort: 3000 }],
      },
    }
    const svcRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services`, {
      method: 'POST',
      body: svc,
    })
    if (!svcRes.ok) {
      // Ignore if already exists
    }

    created++
    logger.info(`Creating warm pod ${name}`)
  }

  logger.info(`Warm pool initialization completed, created ${created} new pods`)
}

/**
 * Allocate an idle Pod from warm pool for tool
 * @param purpose 'deploy' for deployment (mark assigned), 'test' for testing (mark testing)
 * @returns allocation result, null means no idle Pods in pool
 */
export async function allocateFromPool(
  skillId: string,
  code: string,
  mode: 'simple' | 'module',
  envVars?: Array<{ name: string; value: string }>,
  purpose: 'deploy' | 'test' = 'deploy'
): Promise<{ endpoint: string; nodePort: number; podName: string } | null> {
  const pods = await listPoolPods()
  const idlePods = pods.filter((p) => p.status === 'idle' && p.ip)

  if (idlePods.length === 0) {
    logger.info('Warm pool has no idle pods')
    return null
  }

  const statusLabel = purpose === 'test' ? 'testing' : 'assigned'

  // Iterate all idle Pods, skip unhealthy ones
  for (const idlePod of idlePods) {
    logger.info(
      `Attempting to allocate pod ${idlePod.name} from warm pool for skill ${skillId} (purpose: ${purpose})`
    )

    // 1. Health check — quick confirm Pod reachable
    const healthy = await checkPodHealth(idlePod.ip)
    if (!healthy) {
      logger.warn(`Pod ${idlePod.name} health check failed, skipping and destroying`)
      destroyBadPod(idlePod.name)
      continue
    }

    // 2. Inject code
    try {
      const safeEnvVars = envVars
        ? Object.fromEntries(envVars.map((e) => [e.name, String(e.value ?? '')]))
        : undefined
      const injectRes = await podHttpCall(idlePod.ip, '/_inject', 'PUT', {
        code,
        mode,
        envVars: safeEnvVars,
      })
      if (!injectRes.ok) {
        logger.error(
          `Failed to inject code into ${idlePod.name}: ${JSON.stringify(injectRes.data)}, skipping`
        )
        destroyBadPod(idlePod.name)
        continue
      }
    } catch (err) {
      logger.error(
        `Code injection into ${idlePod.name} timed out/failed: ${err instanceof Error ? err.message : String(err)}, skipping`
      )
      destroyBadPod(idlePod.name)
      continue
    }

    // 3. Update Pod labels to mark status
    await patchPodLabels(idlePod.name, {
      'pool-status': statusLabel,
      'skill-id': skillId,
    })

    // 4. Get NodePort
    const nodePort = await getServiceNodePort(idlePod.name)
    if (!nodePort) {
      logger.error(`Failed to get NodePort for ${idlePod.name}`)
      continue
    }

    const endpoint = `http://${K8S_NODE_IP}:${nodePort}`
    logger.info(`Pod ${idlePod.name} allocated, endpoint: ${endpoint}`)

    // 5. Async replenish pool
    ensurePoolCapacity().catch((err) => {
      logger.warn(
        `Failed to replenish warm pool: ${err instanceof Error ? err.message : String(err)}`
      )
    })

    return { endpoint, nodePort, podName: idlePod.name }
  }

  logger.info('All idle pods are unavailable')
  return null
}

/**
 * Allocate an idle Pod from warm pool for testing (no code injection, inject later via API)
 * @returns allocation result, null means no idle Pods in pool
 */
export async function allocateTestPod(): Promise<{
  endpoint: string
  nodePort: number
  podName: string
} | null> {
  const pods = await listPoolPods()
  const idlePods = pods.filter((p) => p.status === 'idle' && p.ip)

  if (idlePods.length === 0) {
    logger.info('Warm pool has no idle pods (for testing)')
    return null
  }

  for (const idlePod of idlePods) {
    logger.info(`Attempting to allocate test pod ${idlePod.name}`)

    // Health check
    const healthy = await checkPodHealth(idlePod.ip)
    if (!healthy) {
      logger.warn(`Pod ${idlePod.name} health check failed, skipping and destroying`)
      destroyBadPod(idlePod.name)
      continue
    }

    // Mark as testing
    await patchPodLabels(idlePod.name, {
      'pool-status': 'testing',
    })

    // Get NodePort
    const nodePort = await getServiceNodePort(idlePod.name)
    if (!nodePort) {
      logger.error(`Failed to get NodePort for ${idlePod.name}`)
      await patchPodLabels(idlePod.name, { 'pool-status': 'idle' })
      continue
    }

    const endpoint = `http://${K8S_NODE_IP}:${nodePort}`
    logger.info(`Test pod ${idlePod.name} allocated, endpoint: ${endpoint}`)

    // Async replenish pool
    ensurePoolCapacity().catch((err) => {
      logger.warn(
        `Failed to replenish warm pool: ${err instanceof Error ? err.message : String(err)}`
      )
    })

    return { endpoint, nodePort, podName: idlePod.name }
  }

  logger.info('All idle pods are unavailable (for testing)')
  return null
}

/**
 * Recycle test Pod to warm pool
 */
export async function recycleTestPod(podName: string): Promise<void> {
  const pods = await listPoolPods()
  const pod = pods.find((p) => p.name === podName && p.status === 'testing')

  if (!pod) {
    logger.info(`Test pod ${podName} not found, may have already been recycled`)
    return
  }

  const idleCount = pods.filter((p) => p.status === 'idle').length

  if (idleCount >= POOL_SIZE) {
    logger.info(`Warm pool is full (${idleCount}/${POOL_SIZE}), destroying test pod ${podName}`)
    await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`, { method: 'DELETE' })
    await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services/${podName}`, { method: 'DELETE' })
    return
  }

  // Recycle: health check + reset first, mark as idle only on success; destroy on failure
  logger.info(`Recycling test pod ${podName} to warm pool`)
  try {
    const healthy = await checkPodHealth(pod.ip)
    if (!healthy) throw new Error('Health check failed')
    const resetRes = await podHttpCall(pod.ip, '/_reset', 'POST')
    if (!resetRes.ok) throw new Error('Reset returned failure')
  } catch (err) {
    logger.warn(
      `Test pod ${podName} reset failed (${err instanceof Error ? err.message : String(err)}), destroying`
    )
    destroyBadPod(podName)
    return
  }

  await patchPodLabels(podName, {
    'pool-status': 'idle',
    'skill-id': null,
  })
}

/**
 * Recycle Pod to warm pool
 * Destroy Pod if pool full (idle >= POOL_SIZE)
 */
export async function recycleToPool(skillId: string): Promise<void> {
  const pods = await listPoolPods()
  const assignedPod = pods.find((p) => p.status === 'assigned' && p.skillId === skillId)

  if (!assignedPod) {
    logger.info(`No warm pool pod found for skill ${skillId}, may be a traditional deployment`)
    return
  }

  const idleCount = pods.filter((p) => p.status === 'idle').length

  if (idleCount >= POOL_SIZE) {
    // Pool full, destroy Pod and Service
    logger.info(`Warm pool is full (${idleCount}/${POOL_SIZE}), destroying pod ${assignedPod.name}`)
    await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods/${assignedPod.name}`, {
      method: 'DELETE',
    })
    await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services/${assignedPod.name}`, {
      method: 'DELETE',
    })
    return
  }

  // Recycle: health check + reset first, mark as idle only on success; destroy on failure
  logger.info(`Recycling pod ${assignedPod.name} to warm pool`)
  try {
    const healthy = await checkPodHealth(assignedPod.ip)
    if (!healthy) throw new Error('Health check failed')
    const resetRes = await podHttpCall(assignedPod.ip, '/_reset', 'POST')
    if (!resetRes.ok) throw new Error('Reset returned failure')
  } catch (err) {
    logger.warn(
      `Pod ${assignedPod.name} reset failed (${err instanceof Error ? err.message : String(err)}), destroying`
    )
    destroyBadPod(assignedPod.name)
    return
  }

  await patchPodLabels(assignedPod.name, {
    'pool-status': 'idle',
    'skill-id': null,
  })
}

/**
 * Find assigned Pod info in warm pool by skillId
 */
export async function findAssignedPod(
  skillId: string
): Promise<{ podName: string; endpoint: string; nodePort: number } | null> {
  const pods = await listPoolPods()
  const pod = pods.find((p) => p.status === 'assigned' && p.skillId === skillId)
  if (!pod) return null

  const nodePort = await getServiceNodePort(pod.name)
  if (!nodePort) return null

  return {
    podName: pod.name,
    endpoint: `http://${K8S_NODE_IP}:${nodePort}`,
    nodePort,
  }
}

/** Ensure sufficient idle Pods in pool */
async function ensurePoolCapacity(): Promise<void> {
  const pods = await listPoolPods()
  const idleCount = pods.filter((p) => p.status === 'idle').length
  const deficit = POOL_SIZE - idleCount

  if (deficit <= 0) return

  logger.info(`Warm pool idle shortage (${idleCount}/${POOL_SIZE}), replenishing ${deficit} pods`)

  const existingNames = new Set(pods.map((p) => p.name))
  let created = 0
  for (let i = 0; created < deficit && i < POOL_SIZE + 200; i++) {
    const name = poolPodName(i)
    if (existingNames.has(name)) continue

    const podRes = await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/pods`, {
      method: 'POST',
      body: buildPoolPod(name),
    })
    if (podRes.ok) {
      // Create Service (exact match to this Pod via pod-name label)
      await k8sApi(`/api/v1/namespaces/${K8S_NAMESPACE}/services`, {
        method: 'POST',
        body: {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name,
            namespace: K8S_NAMESPACE,
            labels: { app: POOL_LABEL_APP, 'pool-pod': name },
          },
          spec: {
            type: 'NodePort',
            selector: { app: POOL_LABEL_APP, 'pod-name': name },
            ports: [{ port: 3000, targetPort: 3000 }],
          },
        },
      })
      created++
      logger.info(`Replenishing warm pod ${name}`)
    }
  }
}

export { POOL_SIZE, WARM_SERVER_CODE }
