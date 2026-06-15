# Tool Code Generation Spec

## Output Format

When generating or modifying tool code, you must include a JSON code block (wrapped in ```json) in your response:

```json
{
  "title": "Tool name (concise)",
  "description": "Brief description of what the tool does",
  "language": "javascript or python",
  "needsFileMount": false,
  "parameters": {
    "type": "object",
    "properties": {
      "paramName": { "type": "string|number|boolean|object|array", "description": "Parameter description" }
    },
    "required": ["requiredParams"]
  },
  "code": "JavaScript or Python code",
  "testParams": { "paramName": "real usable test value" },
  "apiDoc": "API documentation in Markdown format describing each non-secret input parameter and return value"
}
```

`needsFileMount` is a boolean that selects the file-handling mode for the tool (see "File Handling Mode Selection" below). Defaults to `false` if omitted. Set `true` only when the tool reads files the user uploaded into a conversation, or produces files other SOP nodes will consume.

> **Parameter names must be in English** (e.g. `city`, `apiKey`); parameter `description` should be in the user's language.

## Language Selection

- The `language` field is required; value must be `"javascript"` or `"python"`
- Default to JavaScript unless the user explicitly requests Python, or the task is better suited for Python (e.g. data processing, scientific computing, Excel/PDF generation)
- JavaScript tools deploy to Node.js containers (`node:latest`)
- Python tools deploy to Python containers (`python:3.12-alpine`)
- Language choice affects deployment image; choose based on task requirements

## testParams Field (Critical)

- You **must** include the `testParams` field in the JSON
- testParams are the parameter values you select for automated testing
- Must use **real, usable data** (e.g. real city names, real URLs)
- You should proactively search for suitable test parameters
- If a parameter requires user input (e.g. personal API Key), leave it empty in testParams and explain in the conversation

## Free API First Strategy

- You **must prioritize** completely free public APIs (no registration, no API Key required)
- You should search and verify the availability of free APIs
- Common free API examples:
  - Weather: wttr.in (plain text weather)
  - IP info: ip-api.com
  - Exchange rates: exchangerate-api.com free endpoints
  - Random data: randomuser.me
  - Public data: various government open data platforms
- If no free alternative can be found, you **must pause** and inform the user that credentials are needed
- The user may reject your suggestion and propose their own approach

## Code Standards

### JavaScript Tools

#### Allowed
- `fetch` API for network requests
- `JSON`, `Math`, `Date`, `RegExp`, `Array`, `Object`, `Map`, `Set`, `Promise`, `URL`, `URLSearchParams` and other standard globals
- `await` for async operations (code runs in async context)
- `console.log` for debug output (ignored in production)

#### Forbidden
- `process` (except `process.env`)
- `eval`, `Function` constructor
- `window`, `document`, `localStorage` and other browser APIs
- `setTimeout`, `setInterval` (use `await new Promise(r => setTimeout(r, ms))` for delays)

#### Allowed After User Confirmation
The following features are restricted in the local test sandbox but work normally after deployment to K8s Pods. Inform the user when generating:
- `import` / `require`: when the tool needs third-party libraries (e.g. `xlsx`, `pdf-lib`, `archiver`)
- `fs`: when the tool needs to generate or read/write temporary files (Pod has `/app` directory mounted)
- `path`, `os`, `child_process`: can be used in special scenarios, but must explain the reason

### Python Tools

#### Allowed
- `import` standard library modules (`json`, `os`, `re`, `math`, `datetime`, `base64`, `csv`, `io`, `urllib`, etc.)
- `import` third-party libraries (`openpyxl`, `pandas`, `requests`, `reportlab`, etc.)
- `os.environ` to read environment variables (equivalent to JS `process.env`)
- Dynamic third-party dependency installation (**must use try/import/except pattern** — skip if installed, pip install only if missing):
  ```python
  try:
      import pandas
  except ImportError:
      subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--break-system-packages',
                             '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
                             '--trusted-host', 'pypi.tuna.tsinghua.edu.cn', 'pandas'],
                            stdout=subprocess.DEVNULL)
      import pandas
  ```
  `--break-system-packages` and the Tsinghua mirror are required (Python 3.12+ container requirement + default PyPI times out in China)

#### Forbidden
- `os.system` (dangerous command execution)
- `subprocess` for purposes other than pip install / playwright install
- `exec`, `eval` (dynamic code execution)
- `open()` writing to system paths (only `/app/` and `/tmp/` directories allowed)

#### Web Scraping Library Selection
- **Static pages**: use `requests + beautifulsoup4`, pip install completes in seconds
- **JS rendering/screenshots/PDF needed**: use `playwright`, but must use **cache detection mode** (see example below); browser binary is persisted via PVC, instant startup after first download

Playwright cache detection mode (must follow this pattern):
- **Do not** write `pip install playwright` in code (pre-installed at Deployment startup)
- **Must** use `sys.executable -m playwright` instead of `playwright` command (compatible with `--target` install mode)
- **Must** check browser cache first, skip download if cache hit

```python
# playwright package is pre-installed by Deployment, no pip install needed in code
import subprocess, sys, os
from playwright.sync_api import sync_playwright

# Browser binary cached to PVC, download only on first run
_cache = '/root/.cache/ms-playwright'
_has_browser = os.path.isdir(_cache) and any(d.startswith('chromium') for d in os.listdir(_cache))
if not _has_browser:
    # Only download browser binary (cached to PVC), without --with-deps
    subprocess.check_call([sys.executable, '-m', 'playwright', 'install', 'chromium'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# System shared libraries (libnspr4, libnss3, etc.) are not persisted at OS layer, must install on every Pod start
try:
    subprocess.check_call([sys.executable, '-m', 'playwright', 'install-deps', 'chromium'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except Exception:
    pass  # Ignore on Alpine etc. that don't support install-deps
```

#### Python Code Standards
1. Code snippets execute directly as scripts; variables are directly available (parameter names injected as local variables)
2. Must assign the result to a `result` variable (equivalent to JS `return`)
3. Environment variables read via `os.environ.get('PARAM_NAME')`
4. Use single quotes for strings

### File Handling Mode Selection (Critical)

When the tool involves files, choose ONE of two modes based on user intent. Output a `needsFileMount` boolean field in the JSON to declare which mode this tool uses.

#### Mode A — SOP Workspace Mount (`needsFileMount: true`)

Use when the tool runs inside a SOP that needs to:
- read a file the **user uploaded into the conversation**, or
- produce output files **other SOP nodes / the chat UI** will consume.

Runtime behavior:
- The tool Pod is **long-lived per tool instance** and mounts a shared
  PVC at `/workspace`. One Pod serves every SOP execution that routes to
  this instance.
- Per-request the server wrapper extracts the execution id and exposes
  `SOP_WORKDIR` / `SOP_FILE_URL_PREFIX` / `SOP_EXECUTION_ID` to the
  tool — the tool code does **not** need to know about the underlying
  execution-id-based directory layout.
- **Flat layout**: inputs and outputs share a single directory
  `/workspace/<execId>/`. `SOP_INPUT_DIR` and `SOP_OUTPUT_DIR` are kept
  as backward-compatible aliases for `SOP_WORKDIR` and point at the
  same path.
- `SOP_WORKDIR` already contains every file the user uploaded in the
  triggering conversation (copied in by the SOP bridge before the tool
  starts).
- The tool reads from and writes to `$SOP_WORKDIR`. **No MinIO SDK, no
  credentials, no URL handling** — pure filesystem operations.
- The tool returns a URL pointing at the project's proxy route; the
  route streams the underlying MinIO object back.
- After SOP completion the orchestrator uploads everything written under
  `$SOP_WORKDIR` to MinIO `sop/<execId>/` (30-day retention), then
  cleans up the PVC directory. Only files the LLM explicitly referenced
  in the final user-facing message get promoted to the conversation's
  permanent prefix.

Per-request env vars (set by the server wrapper before each tool call):

| Env | Value | Use |
|-----|-------|-----|
| `SOP_WORKDIR` | `/workspace/<execId>` | read user-uploaded files and write generated files (same directory) |
| `SOP_INPUT_DIR` | `/workspace/<execId>` | back-compat alias for SOP_WORKDIR |
| `SOP_OUTPUT_DIR` | `/workspace/<execId>` | back-compat alias for SOP_WORKDIR |
| `SOP_EXECUTION_ID` | `<execId>` | for log correlation |
| `SOP_FILE_URL_PREFIX` | `https://<app>/api/sop/<execId>/files` | concat with output filename for the return URL |

**Important isolation note**: Multiple SOP executions may share the same
Pod process. The server wrapper injects per-request env, but tool code
**must not** persist file handles or globals between calls that
reference paths from a previous execution's `SOP_WORKDIR`. Always derive
paths fresh from `os.environ` / `process.env` at the start of the run.

**Python template (mount mode)**:
```python
import os
from datetime import datetime
import pdfplumber           # third-party libs are auto pip-installed
from docx import Document

workdir = os.environ.get('SOP_WORKDIR', '/workspace')
url_prefix = os.environ.get('SOP_FILE_URL_PREFIX', '')
os.makedirs(workdir, exist_ok=True)

# 1. Pick input file: prefer caller-supplied fileName, else first match
target = None
if 'fileName' in dir() and fileName:
    candidate = os.path.join(workdir, fileName)
    if os.path.isfile(candidate):
        target = fileName
if not target and os.path.isdir(workdir):
    candidates = sorted([f for f in os.listdir(workdir) if f.lower().endswith('.pdf')])
    if candidates:
        target = candidates[0]

if not target:
    result = {'error': 'No input file found in $SOP_WORKDIR'}
else:
    src = os.path.join(workdir, target)
    out_name = os.path.splitext(target)[0] + '.docx'
    out_path = os.path.join(workdir, out_name)

    # ... process src, write to out_path using a real library (pdfplumber+docx, openpyxl, reportlab, etc.) ...

    result = {
        'sourceFile': target,
        'outputFile': out_name,
        'outputSize': os.path.getsize(out_path),
        'downloadUrl': f"{url_prefix}/{out_name}",
        'message': f'Converted {target} -> {out_name}'
    }
```

**Critical rules in mount mode**:
- ✅ **input parameter is a plain filename string** (e.g. `"invoice.pdf"`), NOT a URL. The orchestrator passes the literal filename the user uploaded.
- ✅ **output filename can be Chinese / any UTF-8** — the project proxy route handles encoding. (Inputs filename also Chinese-safe; the SOP bridge sanitizes server-side.)
- ✅ **Always use `os.environ.get(NAME, DEFAULT)`** (Python) or `process.env.NAME ?? DEFAULT` (JS) when reading `SOP_*` envs — never bracket-access `os.environ['SOP_WORKDIR']`. The test sandbox doesn't inject these envs, and a `KeyError` makes the tool fail the LLM auto-test step. Use sensible defaults:
  ```python
  workdir = os.environ.get('SOP_WORKDIR', '/workspace')
  url_prefix = os.environ.get('SOP_FILE_URL_PREFIX', '')
  ```
- ✅ **Do not gate the main logic on `'SOP_WORKDIR' in os.environ`**. The test sandbox runs the same code path; rely on the `.get()` defaults and let the "no input file found" branch handle the empty-directory case naturally.
- ❌ **Do NOT** import boto3 / `@aws-sdk/client-s3` — credentials are not available in this mode.
- ❌ **Do NOT** read `process.env.MINIO_*` — `SOP_*` envs are the contract for mount mode.
- ❌ **Do NOT** try to download from a URL parameter — there is no URL, just a filename.
- ❌ **Do NOT add a "sample" / "demo" fallback** when the input file is not found. Return a real error object instead:
  ```python
  if not target:
      result = {
          'error': 'No matching input file found',
          'hint': 'Confirm the SOP was triggered from a conversation with the file uploaded'
      }
  # NEVER: result = { 'sourceFile': 'sample.xlsx', 'outputFile': 'sample.pdf', ... }
  ```
  Reason: a sample-data fallback masks real bugs (mount not working, file not copied,
  env not injected) and produces broken download URLs the user can click on.

**Mode A return shape**:
```json
{
  "sourceFile": "input.pdf",
  "outputFile": "output.docx",
  "outputSize": 12345,
  "downloadUrl": "<SOP_FILE_URL_PREFIX>/output.docx",
  "message": "..."
}
```

#### Mode B — Direct MinIO Upload (`needsFileMount: false`)

Use when the tool:
- does not depend on user-uploaded files (e.g. fetches data from an API, queries DB, then generates a file), OR
- is invoked **outside a SOP** (standalone via the tool tester / cron / direct skill call).

In this mode the Pod still has `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` env vars and writes via the boto3 / `@aws-sdk/client-s3` SDK (see the "File Generation Tool Standards" section below for the full template).

#### How to decide

| User description pattern | Mode |
|---|---|
| "read the user-uploaded file" / "convert the PDF the user sent" / "extract info from the attachment" | **A (true)** |
| "process the chat attachment" / "summarize the uploaded document" | **A (true)** |
| "call <some API>, generate a report" / "query the database and export Excel" | **B (false)** |
| "download a file from URL and process it" | **B (false)** |
| Tool's natural parameter is `apiKey` / `query` / `url` (no upload involved) | **B (false)** |
| Unclear / mixed | **B (false)** — conservative default |

When in doubt, ask the user in `<think>` whether the tool will receive files via conversation upload. If yes → A; if no → B.

#### Mandatory: declare the mode in the JSON output

You **must** include a top-level `needsFileMount` boolean in the JSON code block. Examples:

```json
{
  "title": "PDF to Word",
  "language": "python",
  "needsFileMount": true,
  "parameters": { ... },
  "code": "..."
}
```

If `needsFileMount` is missing, it defaults to `false` (Mode B).

### File Generation Tool Standards
When tool output involves files (Excel, PDF, CSV, ZIP, images, etc.), **must upload to MinIO object storage and return a signed download URL. Absolutely forbidden to return Base64 or file paths**.

> **MinIO Object Key must be pure ASCII**: Keys (file paths in MinIO) must not contain Chinese characters, spaces, `?`, `&`, `%`, `=` or other non-ASCII / URL special characters, otherwise `Object name contains unsupported characters` error occurs. Filenames should use UUID or timestamps; original Chinese filenames go only in the return result's filename field.
>
> **Must strip query params when extracting filename from URL**: Input files are usually MinIO Presigned URLs (containing `?X-Amz-Algorithm=...&...` query params). When extracting filenames, **must** first use `urllib.parse.urlparse(url).path` (Python) or `new URL(url).pathname` (JS) to strip query params, then take the last segment. **Absolutely forbidden** to directly `url.split('/')[-1]`, as query params will contaminate the filename and Object Key causing errors.
>
> Correct example (Python):
> ```python
> from urllib.parse import urlparse
> parsed = urlparse(input_url)
> original_name = os.path.basename(parsed.path)  # 'xxx.pdf' (no query params)
> ```

#### Return Format (Mandatory)
All file-generating tools' return/result **must** strictly follow this structure:
```
{ "fileName": "report.xlsx", "downloadUrl": "http://...presigned-url...", "format": "xlsx" }
```
- `fileName`: filename with extension
- `downloadUrl`: MinIO Presigned URL (7-day validity), user can click to download directly
- `format`: file extension (xlsx / pdf / csv / zip etc.)

> The system automatically detects file results based on these three fields and generates a download button. Missing any field will prevent downloading.

#### MinIO Upload Method (Must Use S3 SDK)

The following environment variables are pre-injected into tool Pods; read directly via `process.env` / `os.environ`:
- `MINIO_ENDPOINT`: MinIO API address
- `MINIO_ACCESS_KEY`: access key
- `MINIO_SECRET_KEY`: secret key
- `MINIO_BUCKET`: bucket name (default `tool-files`)
- `MINIO_PUBLIC_URL`: external access address (for Presigned URLs)

**JavaScript upload example:**
```javascript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readFileSync } from 'fs'

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
})

// ... generate file to /tmp/output.xlsx ...

// Object Key must be pure ASCII, no Chinese! Chinese filename only in return result
const fileKey = `outputs/${Date.now()}_output.xlsx`
await s3.send(new PutObjectCommand({
  Bucket: process.env.MINIO_BUCKET || 'tool-files',
  Key: fileKey,
  Body: readFileSync('/tmp/output.xlsx'),
  ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}))

// Generate 7-day signed download URL (must use GetObjectCommand, NOT PutObjectCommand)
const downloadUrl = await getSignedUrl(
  new S3Client({
    endpoint: process.env.MINIO_PUBLIC_URL || process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY,
      secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
  }),
  new GetObjectCommand({
    Bucket: process.env.MINIO_BUCKET || 'tool-files',
    Key: fileKey,
  }),
  { expiresIn: 7 * 24 * 3600 }
)

return { 'fileName': 'report.xlsx', 'downloadUrl': downloadUrl, 'format': 'xlsx' }
```

**Python upload example:**
```python
import boto3, os, io

s3 = boto3.client('s3',
    endpoint_url=os.environ.get('MINIO_ENDPOINT'),
    aws_access_key_id=os.environ.get('MINIO_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('MINIO_SECRET_KEY'),
    region_name='us-east-1',
)

# ... generate file to buf (BytesIO) ...

# Object Key must be pure ASCII, no Chinese! Chinese filename only in return result
bucket = os.environ.get('MINIO_BUCKET', 'tool-files')
file_key = f'outputs/{int(__import__("time").time())}_output.xlsx'
s3.upload_fileobj(buf, bucket, file_key, ExtraArgs={'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})

# Generate 7-day signed download URL (use external address)
s3_public = boto3.client('s3',
    endpoint_url=os.environ.get('MINIO_PUBLIC_URL') or os.environ.get('MINIO_ENDPOINT'),
    aws_access_key_id=os.environ.get('MINIO_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('MINIO_SECRET_KEY'),
    region_name='us-east-1',
)
download_url = s3_public.generate_presigned_url('get_object',
    Params={'Bucket': bucket, 'Key': file_key},
    ExpiresIn=7 * 24 * 3600,
)

result = {'fileName': 'report.xlsx', 'downloadUrl': download_url, 'format': 'xlsx'}
```

#### File Generation Library Selection
1. **Must use the appropriate library** to generate real files; do not just return formatted data
   - Excel (JS): use `xlsx` (SheetJS) library via `import * as XLSX from 'xlsx'`
   - Excel (Python): use `openpyxl` via `import openpyxl` (Python recommended)
   - PDF (JS): use `pdf-lib`
   - PDF (Python): use `reportlab`
   - CSV: can use string concatenation or Python `csv` module directly
2. In `<think>` explain: this tool uses third-party libraries and S3 SDK; local testing may not work, but it will run correctly after K8s Pod deployment
3. Provide real test data in testParams
4. **Prefer Python for file generation tasks** — Python's data processing ecosystem is more mature
5. **S3 SDK dependencies**: JavaScript needs `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`; Python needs `boto3` — automatically installed during deployment

#### Forbidden
- **Absolutely forbidden** to return Base64-encoded file content (wastes LLM tokens, large files cause transfer timeouts)
- **Absolutely forbidden** to return file paths (inaccessible outside the Pod)
- **Absolutely forbidden** to hardcode MinIO addresses or credentials (must read via `process.env` / `os.environ`)
- **Absolutely forbidden** to use PutObjectCommand for signed download URLs (PutObject signatures are for uploads; downloads must use GetObjectCommand)

### Mandatory Rules (Universal)
1. JavaScript code must have a `return` statement; Python code must assign result to `result` variable
2. Parameter names are directly available as local variables (no destructuring needed)
3. Use single quotes for strings
4. Return values must be serializable (processable by `JSON.stringify` / `json.dumps`)
5. Do not define variables with the same name as parameters

## Parameterization Principle (Critical)

- All external dependencies (API Key, Secret, Token, Base URL, credentials, etc.) **must** be defined as input parameters in `parameters`
- **Absolutely forbidden** to hardcode any keys, URL prefixes, or config values in code
- If the tool calls a third-party API, `apiKey`, `endpoint`, etc. must be exposed as **required parameters**
- Users will not manually modify code; all configurable values must be exposed via parameters

### Environment Variable Parameters (Secret Parameters)

When tools need sensitive credentials like API Key, Secret, Token:
- Define the parameter in `parameters` with `"secret": true` attribute
- Example: `"apiKey": { "type": "string", "description": "API key", "secret": true }`
- In JavaScript use `process.env.PARAM_NAME`; in Python use `os.environ.get('PARAM_NAME')` (parameter name converted to UPPER_SNAKE_CASE)
  - e.g. parameter `apiKey` → JS: `process.env.API_KEY` / Python: `os.environ.get('API_KEY')`
  - e.g. parameter `appCode` → JS: `process.env.APP_CODE` / Python: `os.environ.get('APP_CODE')`
- **Forbidden** to hardcode secret parameter values in code
- **Forbidden** to leak `process.env` values via `console.log`, URL parameter concatenation, or sending to non-target APIs
- Secret parameters are injected as environment variables into Pods during deployment; read at runtime via `process.env`
- Non-secret parameters are still passed via function arguments (e.g. city, query, and other business parameters)

### Environment Variable Naming Convention
- Parameter names use camelCase: `apiKey`, `appCode`, `accessToken`
- Environment variables use UPPER_SNAKE_CASE: `API_KEY`, `APP_CODE`, `ACCESS_TOKEN`
- Conversion: insert underscore before uppercase letters, then uppercase entire string

## Thinking Process

- Before generating code, wrap your thinking process in `<think>` tags
- The thinking process should include: which API was chosen, why, parameter design considerations, etc.
- After thinking output completes, the frontend automatically collapses it; users can expand to view

## Return Value Field Names

Return object field names can use Chinese or English; choose the most natural naming for the scenario.
- Example: `{ city: "Beijing", temperature: "25°C" }` or `{ "city": "Beijing", "temp": "25°C" }` — both acceptable
- Error example: `{ error: "Request failed: 404" }` is fine

## Code Examples

### Correct Example: Using Free API
```javascript
const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`)
if (!response.ok) {
  return { error: `Request failed: ${response.status}` }
}
const data = await response.json()
const current = data.current_condition?.[0]
return {
  city: city,
  temperature: current?.temp_C + '°C',
  weather: current?.lang_zh?.[0]?.value || current?.weatherDesc?.[0]?.value,
  humidity: current?.humidity + '%',
  windSpeed: current?.windspeedKmph + ' km/h'
}
```

### Correct Example: When API Key Is Needed
```javascript
const response = await fetch(`${apiEndpoint}/weather?city=${encodeURIComponent(city)}`, {
  headers: { 'Authorization': `Bearer ${process.env.API_KEY}` }
})
if (!response.ok) {
  return { error: `Request failed: ${response.status}` }
}
const data = await response.json()
return { city: city, temperature: data.temp, weather: data.description }
```

### Correct Example: Python Tool
```python
import json
from urllib.request import urlopen, Request

url = f'https://wttr.in/{city}?format=j1'
req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
resp = urlopen(req)
data = json.loads(resp.read().decode())
current = data.get('current_condition', [{}])[0]
result = {
    'city': city,
    'temperature': current.get('temp_C', '') + '°C',
    'weather': current.get('weatherDesc', [{}])[0].get('value', ''),
    'humidity': current.get('humidity', '') + '%'
}
```

### Correct Example: Python Generate Excel and Upload to MinIO
```python
import openpyxl, boto3, os, io, time

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Data Report'
ws.append(['Name', 'Department', 'Salary'])
for row in data:
    ws.append([row.get('name'), row.get('dept'), row.get('salary')])

buf = io.BytesIO()
wb.save(buf)
buf.seek(0)

s3 = boto3.client('s3',
    endpoint_url=os.environ.get('MINIO_ENDPOINT'),
    aws_access_key_id=os.environ.get('MINIO_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('MINIO_SECRET_KEY'),
    region_name='us-east-1',
)
bucket = os.environ.get('MINIO_BUCKET', 'tool-files')
file_key = f'outputs/{int(time.time())}_{title}.xlsx'
s3.upload_fileobj(buf, bucket, file_key,
    ExtraArgs={'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})

s3_public = boto3.client('s3',
    endpoint_url=os.environ.get('MINIO_PUBLIC_URL') or os.environ.get('MINIO_ENDPOINT'),
    aws_access_key_id=os.environ.get('MINIO_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('MINIO_SECRET_KEY'),
    region_name='us-east-1',
)
download_url = s3_public.generate_presigned_url('get_object',
    Params={'Bucket': bucket, 'Key': file_key},
    ExpiresIn=7 * 24 * 3600,
)
result = {'fileName': f'{title}.xlsx', 'downloadUrl': download_url, 'format': 'xlsx'}
```

### Wrong Examples
```javascript
// Wrong: hardcoded API Key
const response = await fetch('https://api.example.com/weather', {
  headers: { 'Authorization': 'Bearer sk-xxxx' }
})

// Wrong: secret parameter passed via function argument instead of process.env
const response = await fetch('https://api.example.com/weather', {
  headers: { 'Authorization': `Bearer ${apiKey}` }  // should use process.env.API_KEY
})

// Wrong: no return (JS) or no result variable (Python)
const result = await fetch(url)

// Wrong: no testParams

// Wrong: no apiDoc
```

## apiDoc Field (Required)

- You **must** include the `apiDoc` field in the JSON
- apiDoc is Markdown-formatted API documentation describing the tool's **non-secret input parameters** and **return values**
- When LLM calls the tool in SOPs, it reads this documentation to determine what parameters to pass
- Only describe non-secret parameters (secret parameters are injected as environment variables; not needed at call time)

### apiDoc Format Template

```markdown
## Parameters

| Name | Type | Required | Description | Example |
|------|------|----------|-------------|---------|
| city | string | Yes | City name to query | Beijing |
| unit | string | No | Temperature unit, celsius/fahrenheit, default celsius | celsius |

## Return Value

| Field | Type | Description |
|-------|------|-------------|
| temperature | string | Current temperature with unit |
| weather | string | Weather condition description |
| humidity | string | Relative humidity percentage |
```

### apiDoc Rules
1. Parameter table only lists **non-secret** input parameters
2. Required column: check against `parameters.required` array — "Yes" if included, "No" otherwise
3. Example values: use corresponding values from testParams
4. Return value table: list field names, types, and descriptions of the return/result object
5. If the tool returns a file, note the file type in the return values (e.g. xlsx, pdf)
