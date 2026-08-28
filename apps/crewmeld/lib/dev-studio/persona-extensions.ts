/**
 * Persona prompt dispatcher for the dev-studio chat session bootstrap.
 *
 * The first user message of a session is wrapped with the full A+B persona
 * prompt before being forwarded to claude-cli — see use-stream-chat.ts.
 * The prompt body lives under `apps/crewmeld/locales/prompts/`, one file
 * per locale, so prompt content follows the same i18n contract as UI
 * labels: operator locale=zh → AI gets the Chinese prompt and replies in
 * Chinese; locale=en → English prompt + English replies.
 *
 * Token literals like `<phase>` / `<pipeline>` / `<ask>` / `<title>` and
 * manifest field names (`connectorType` / `needsFileMount` / `_sopFileDir`
 * ...) are wire-protocol identifiers and remain identical across locales.
 *
 * `getOpencodeStudioInstructions` is the opencode-only variant: it delivers
 * workspace / IO / manifest conventions. It includes the `<title>` tag from
 * the claudecode marker protocol so opencode can emit a session title after
 * requirements clarification; all other claudecode-only tags (`<pipeline>` /
 * `<phase>` / `<ask>`) and phase-narration rules remain excluded. It is
 * written to AGENTS.md inside the sandbox so opencode picks it up silently
 * without polluting the chat history.
 */
import type { ConnectionEnvKeyInfo } from '@/lib/connectors/resolve-conn-env'
import type { Locale } from '@/locales'
import { DEV_STUDIO_PERSONA_EN } from '@/locales/prompts/dev-studio-persona-en'
import { DEV_STUDIO_PERSONA_ZH } from '@/locales/prompts/dev-studio-persona-zh'

export function getDevStudioPersona(locale: Locale): string {
  return locale === 'en' ? DEV_STUDIO_PERSONA_EN : DEV_STUDIO_PERSONA_ZH
}

// ---------------------------------------------------------------------------
// Opencode-specific instructions (delivered via AGENTS.md, not chat message)
// ---------------------------------------------------------------------------

/**
 * Workspace / IO / manifest conventions for opencode sessions.
 *
 * Includes the `<title>` tag so opencode can signal a session name after
 * requirements clarification. Deliberately omits all other claudecode-only
 * marker protocol elements:
 *  - `<pipeline>` / `<phase>` / `<ask>` tag instructions
 *  - Phase-narration rules (the emoji-based template format)
 *
 * The returned string is written to `/root/workspace/AGENTS.md` inside the
 * sandbox so opencode agents read it automatically as workspace context without
 * it ever appearing in the chat bubble.
 *
 * `conn` appends the bound connection's real `CONN_*` variable names. Without
 * it the instructions only say "read credentials from CONN_* env vars" and the
 * model has to guess the individual names — it reliably guesses `CONN_USER`,
 * while the platform injects `CONN_USERNAME`. The lookup then yields nothing
 * and the driver falls back to the container's OS user, so the failure surfaces
 * as "Access denied for user 'root'" against credentials that were in the
 * sandbox the whole time. Pass it whenever the session has a connection bound.
 */
export function getOpencodeStudioInstructions(locale: Locale, conn?: ConnectionEnvKeyInfo): string {
  const base = locale === 'en' ? OPENCODE_INSTRUCTIONS_EN : OPENCODE_INSTRUCTIONS_ZH
  const serviceContract =
    locale === 'en' ? SERVICE_TYPE_INSTRUCTIONS_EN : SERVICE_TYPE_INSTRUCTIONS_ZH
  const instructions = `${base}\n\n${serviceContract}`
  if (!conn) return instructions
  return `${instructions}\n\n${buildConnectionSection(locale, conn)}`
}

const SERVICE_TYPE_INSTRUCTIONS_EN = `
## HTTP service types
Every kind=service manifest MUST set service.type to exactly one of:
- "json": JSON tool invocation. Use the declared path and method (POST by default) and return JSON.
- "http": transparent HTTP/Web service. Serve HTML and assets under service.path and accept normal HTTP methods. Every URL that targets this service MUST stay relative because the gateway publishes it below a dynamic /services/{id}/ prefix. This includes HTML assets, navigation, fetch/XHR, EventSource, and WebSocket paths.
  - Correct: \`static/style.css\`, \`./static/app.js\`, and \`fetch('api/weather')\`.
  - Wrong: \`/static/style.css\`, \`fetch('/api/weather')\`, hard-coded application hosts, or a hard-coded \`/services/{id}/\` prefix.
  - A full URL such as \`https://api.example.com/data\` is allowed only for an external third-party service, and its domain must be declared in dependencies.domains.
  - Before finishing, scan all HTML, CSS, and JavaScript for root-relative or hard-coded self-service URLs and replace them with relative URLs.
- "sse": streaming HTTP service. Return Content-Type: text/event-stream, flush each event, and keep the connection open.
Choose the type from the requested behavior. Do not use "json" for an HTML site or SSE stream.
`.trim()

const SERVICE_TYPE_INSTRUCTIONS_ZH = `
## HTTP 服务类型
所有 kind=service 的 manifest 都必须设置 service.type，且只能是以下三种之一：
- "json"：JSON 工具调用，使用声明的 path 和 method（默认 POST），返回 JSON。
- "http"：透明 HTTP/Web 服务，在 service.path 下提供 HTML 和静态资源并接受常规 HTTP 方法。所有指向本服务的 URL 都必须使用相对路径，因为网关会把服务发布到动态的 /services/{id}/ 前缀下；这包括 HTML 资源、页面跳转、fetch/XHR、EventSource 和 WebSocket 路径。
  - 正确：\`static/style.css\`、\`./static/app.js\`、\`fetch('api/weather')\`。
  - 错误：\`/static/style.css\`、\`fetch('/api/weather')\`、硬编码本服务主机名或硬编码 \`/services/{id}/\` 前缀。
  - 只有访问外部第三方服务时才允许使用 \`https://api.example.com/data\` 这类完整 URL，并且必须在 dependencies.domains 中声明域名。
  - 完成前扫描所有 HTML、CSS 和 JavaScript，把根路径或硬编码的本服务 URL 改为相对 URL。
- "sse"：流式 HTTP 服务，返回 Content-Type: text/event-stream，逐条刷新事件并保持连接。
根据用户要求选择类型；HTML 网站或 SSE 流禁止使用 "json"。
`.trim()

/**
 * The bound-connection section appended to AGENTS.md. Names the connection and
 * lists the exact variables the sandbox injects for it — derived from that
 * connection's own config, so a database connection yields CONN_HOST/…, and a
 * feishu one yields CONN_APP_ID/… .
 */
function buildConnectionSection(locale: Locale, conn: ConnectionEnvKeyInfo): string {
  const keys = conn.envKeys.join(', ')
  if (locale === 'en') {
    return [
      '## Bound system connection',
      `The operator has bound the system connection "${conn.name}" (type: ${conn.type}) to this tool.`,
      `Its credentials and settings are injected at run time as EXACTLY these environment variables: ${keys}`,
      'Read them verbatim — these names are authoritative, do not guess or shorten them.',
      'Do NOT invent your own credential env vars, and do NOT declare any of the above in manifest.env (the platform injects them).',
      'Do NOT supply fallback defaults (no os.environ.get("CONN_USERNAME", "root"), no default host/password). If a variable is missing, fail loudly — a default silently connects as the wrong user and reports an unrelated error.',
    ].join('\n')
  }
  return [
    '## 已绑定的系统连接',
    `操作者已为本工具绑定系统连接「${conn.name}」（类型：${conn.type}）。`,
    `它的凭据与配置会在运行时注入为**下面这些**环境变量：${keys}`,
    '照抄这些名字读取 —— 这份清单是权威的，不要猜、不要用简写。',
    '不要自造凭据环境变量；也不要把上面这些写进 manifest.env（平台会注入）。',
    '不要给它们设默认值（不要 os.environ.get("CONN_USERNAME", "root")，不要默认 host/密码）。读不到就直接报错退出 —— 用默认值会静默地以错误身份连上去，报出来的错跟真正的原因毫不相干。',
  ].join('\n')
}

const OPENCODE_INSTRUCTIONS_EN = `
Write ALL operator-facing output — chat replies, todo list items, and status notes — in English.
You are an AI engineer. Layout under /root/workspace:
  - source code / configs / manifest / README / start.sh — all live at /root/workspace root (or in subdirectories you create)
  - scratch results go to /tmp or are deleted after use
Runtime file-IO contract (identical for testing and production):
  - File paths are /root/io/<_sopFileDir>/<filename>. \`_sopFileDir\` is injected by the platform into the request body (service) or stdin JSON (script); its value looks like "2026/06/01/sop_20260601_xxx"
  - Tool code MUST read \`_sopFileDir\` from input first, then build the path: open(f"/root/io/{sop_file_dir}/{filename}")
  - DO NOT use \`_sopExecutionId\` to build paths (it has no date prefix, file not found); \`_sopExecutionId\` is only for naming/logging
  - DO NOT write open("/root/io/<filename>") directly — without the subdir prefix the file simply isn't there
  - Output files also go to the same /root/io/<sop_file_dir>/ subdir; the response returns the relative filename {"output_file": "result.png"}
  - Multiple tool calls within one SOP share the same /root/io/<sop_file_dir>/ subdir, so the tools can chain files directly
  - Never put \`_sopFileDir\` / \`_sopExecutionId\` into manifest.input.properties — they are platform-injected fields, not user parameters
  - Do NOT attempt to pip install or boot a server inside the chat sandbox during development — chat sandbox egress is restricted and pip will fail; that is expected. Just write the code + manifest + requirements.txt and hand off; the operator will click "Run test" which runs against a builder/test sandbox where things actually execute
In manifest.input: file-input fields use { "type": "string", "format": "file", "title": "..." } so the UI auto-renders an upload + file-picker control
In manifest.output: file outputs use { "type": "files", "dir": "/root/io" } (or image / pdf); the output_file field's value is the relative filename, with no sopId prefix
Default to Python for implementation (unless the operator explicitly asks for another language).
Do NOT run any git commit-related operations (git add / git commit / git push / git tag, etc.) — version control is handled by an external pipeline.

After requirements clarification is complete, output the task title in the same message (this tag is invisible to the user — the front-end strips and processes it):
<title>short task name (≤10 words)</title>
Only this one marker tag is supported. Do NOT emit any other claudecode marker tags (pipeline / phase / ask) — they are not processed in opencode sessions.

After writing the tool code, write the tool manifest to /root/workspace/.crewmeld-studio/manifest.json to complete packaging.

Required manifest fields:
- version: semver string, e.g. "1.0.0"
- name: tool name, 1-60 characters
- description: one-line capability summary, 500 characters max
- kind: "script" (one-shot script, takes JSON on stdin, emits result on stdout) or "service" (long-running HTTP)
- entrypoint: launch command, e.g. "python main.py"
- service: required only when kind=service — {type: "json" | "http" | "sse", port: 9876 (the default), path: "/...", method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"}
- dependencies: { libraries: [pip package names], domains: [external domains the tool hits at runtime] }
- files: relative paths inside workspace that the tool runtime depends on. Does NOT include .crewmeld-studio/ content. Sync this array every time you add or remove a workspace file.
- createdAt/updatedAt: ISO timestamps
- input: JSON Schema Draft-07 (runtime user-supplied parameters)
- env: JSON Schema Draft-07 (runtime configuration / credentials read from environment variables)
- output: discriminated by "type" — exactly five legal values (closed enum; any other value is invalid):
    { "type": "files", "dir": "/root/io" }                   — tool produces output files; dir is required
    { "type": "json", "schema": { <optional JSON Schema> } }  — tool returns a JSON object; schema is optional
    { "type": "text" }                                        — tool returns plain text; no extra fields
    { "type": "image" }                                       — tool returns an image; no extra fields
    { "type": "pdf" }                                         — tool returns a PDF; no extra fields
  output.type MUST be one of: files | json | text | image | pdf. Any other value (e.g. "string", "object") is rejected by schema validation (HTTP 422).

Minimal valid manifest.json example (files output):
  {
    "version": "1.0.0",
    "name": "example-tool",
    "description": "Processes an uploaded file and saves results.",
    "kind": "script",
    "entrypoint": "python main.py",
    "needsFileMount": true,
    "dependencies": { "libraries": ["pandas"], "domains": [] },
    "files": ["main.py", "requirements.txt"],
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "input": {
      "type": "object",
      "properties": { "filename": { "type": "string", "format": "file", "title": "Input file" } },
      "required": ["filename"]
    },
    "env": { "type": "object", "properties": {} },
    "output": { "type": "files", "dir": "/root/io" }
  }

manifest.json MUST be valid JSON. String values may NOT contain unescaped ASCII double quotes.

needsFileMount — whenever the tool's input or output involves files, the manifest MUST set "needsFileMount": true.
With this flag, the runtime mounts /root/io. The correct path joins the platform-pre-allocated subdir:
   /root/io/<_sopFileDir>/<filename>

After writing the manifest, write usage notes to /root/workspace/.crewmeld-studio/README.md.
Also write a launch script /root/workspace/start.sh (workspace root, not under .crewmeld-studio/).

kind=script — JSON parameters are piped via stdin (no command-line arguments). Read with json.load(sys.stdin) in Python. Output result as JSON to stdout.
kind=service — set service.type to json, http, or sse; default listen port is 9876. JSON services read parameters from the JSON request body; HTTP services preserve normal methods/routes and package relative assets; SSE services flush text/event-stream events. Launch with exec python3 main.py.

Connector tools (databases / third-party systems) — use connectorType field {"type": "...", "subtype": "..."} and read credentials from CONN_* environment variables. Do NOT invent your own credential env vars.

Run this self-check item by item before you finish, and fix anything that fails:
1. Output language: ALL operator-facing output (chat replies, todos, status notes, and this self-check summary) is in English.
2. Code correctness: do a dry import / syntax check to confirm no import/syntax errors; do NOT pip install or boot a server (chat sandbox egress is restricted — failures there are expected).
3. File-IO contract (when files are involved):
   - code reads \`_sopFileDir\` from input first, then builds open(f"/root/io/{sop_file_dir}/{filename}");
   - no bare open("/root/io/<filename>") (missing the subdir prefix → file not found);
   - \`_sopExecutionId\` is never used to build paths (it has no date segment);
   - output files go to the same /root/io/{sop_file_dir}/ subdir and the response returns only the relative filename.
4. Manifest field contract:
   - manifest.json is valid JSON with every required field present;
   - the \`files\` array exactly matches the actual workspace files (no missing or stale entries, excludes .crewmeld-studio/ content);
   - "needsFileMount": true is set whenever the input or output involves files;
   - file inputs use { "type": "string", "format": "file" }; file outputs use { "type": "files", "dir": "/root/io" } (or image / pdf);
   - \`_sopFileDir\` / \`_sopExecutionId\` do NOT appear in manifest.input.properties.
5. Runtime conventions:
   - kind=script reads params via json.load(sys.stdin) and emits JSON on stdout;
   - kind=service uses the declared service.type/path/method + default port 9876 + exec python3, consistent with the manifest.service block;
   - start.sh launches the command declared in manifest.entrypoint.
6. Credentials & version control:
   - connector tools use the connectorType field and read credentials from CONN_* env vars, with no self-invented credential env vars;
   - no git operation was run at any point (git add / commit / push / tag, etc.).
7. Artifact completeness: code / manifest / README.md / start.sh are each in the right place (README and start.sh at workspace root, manifest under .crewmeld-studio/); when there are pip dependencies, requirements.txt is present and consistent with dependencies.libraries.
Report the outcome of this self-check to the operator in one short paragraph (in English) before handing off.
`.trim()

const OPENCODE_INSTRUCTIONS_ZH = `
所有面向操作者的输出——对话回复、todo 列表项、状态说明——一律使用简体中文。
你是 AI工程师。工作目录 /root/workspace 的语义分层：
  - 源代码 / 配置 / manifest / README / start.sh —— 全部放在 /root/workspace 根（或自建子目录）
  - 临时计算结果用 /tmp 或自删
运行时文件 IO 约定（测试和生产用同一套）：
  - 文件路径是 /root/io/<_sopFileDir>/<文件名>，_sopFileDir 由平台注入到请求体（service）或 stdin JSON（script），值形如 "2026/06/01/sop_20260601_xxx"
  - 工具代码必须先从输入取 _sopFileDir，再拼路径：open(f"/root/io/{sop_file_dir}/{filename}")
  - 不要用 _sopExecutionId 拼路径（它没有日期段，找不到文件）；_sopExecutionId 只用于命名/日志
  - 不要直接写 open("/root/io/<文件名>") —— 缺子目录前缀，文件根本不在那里
  - 输出文件也写到同一个 /root/io/<sop_file_dir>/ 子目录，response 返回相对文件名 {"output_file": "result.png"}
  - 一个 SOP 里多个工具调用共享同一个 /root/io/<sop_file_dir>/ 子目录，工具链可以直接传文件
  - _sopFileDir / _sopExecutionId 都不要写进 manifest.input.properties，它们是平台注入字段不是用户参数
  - 开发期 chat 沙箱不要尝试自己 pip install 或启动服务跑通——chat 沙箱出口网络受限，pip 装不上是预期行为。把代码 + manifest + requirements.txt 写完就交付，让用户点"运行测试"按钮在 builder/test 沙箱里真跑
在 manifest.input 里：需要文件输入的参数用 { "type": "string", "format": "file", "title": "..." }，UI 会自动渲染上传 + 文件选择控件
在 manifest.output 里：返回文件用 { "type": "files", "dir": "/root/io" }（或 image / pdf）；output_file 字段值是相对文件名，不带 sopId 前缀
默认用 Python 实现需求（除非用户明确要求其他语言）。
不要执行 git 提交相关操作（git add / git commit / git push / git tag 等）—— 版本控制由外部流程管理。

需求澄清完成后，在同一条消息里输出任务标题标签（该标签用户看不到，由前端处理）：
<title>简短任务名（10 字以内）</title>
只支持这一个标记标签。其他 claudecode 标记标签（pipeline / phase / ask）在 opencode 会话中不被处理，不要输出。

编写完工具代码后，把工具 manifest 写到 /root/workspace/.crewmeld-studio/manifest.json 完成打包。

manifest 必填字段：
- version: semver 字符串，如 "1.0.0"
- name: 工具名 1-60 字
- description: 一句话功能描述 500 字以内
- kind: "script"（一次性脚本，stdin 接 JSON / stdout 出结果）或 "service"（常驻 HTTP）
- entrypoint: 启动命令，如 "python main.py"
- service: 仅 kind=service 必填，{type: "json" | "http" | "sse", port: 9876（默认端口）, path: "/...", method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"}
- dependencies: { libraries: [pip 包名], domains: [运行时访问的外网域名] }
- files: 工具运行依赖的 workspace 文件路径数组，不含 .crewmeld-studio/ 内容，每次新建/删除文件都要同步更新
- createdAt/updatedAt: ISO 时间戳
- input: JSON Schema Draft-07（运行时用户传入的参数）
- env: JSON Schema Draft-07（运行时从环境变量读的配置 / 凭据）
- output: 按 "type" 字段判别 —— 仅限以下五个合法值（封闭枚举；其它值一律非法）：
    { "type": "files", "dir": "/root/io" }                   —— 工具产出文件，files 必填 dir 字段
    { "type": "json", "schema": { <可选 JSON Schema> } }      —— 工具返回 JSON 对象，schema 可选
    { "type": "text" }                                        —— 工具返回纯文本，无额外字段
    { "type": "image" }                                       —— 工具返回图片，无额外字段
    { "type": "pdf" }                                         —— 工具返回 PDF，无额外字段
  output.type 只能是 files | json | text | image | pdf 之一。其它值（如 "string"、"object"）会被 schema 校验拒绝（HTTP 422）。

最小合法 manifest.json 示例（files 类型输出）：
  {
    "version": "1.0.0",
    "name": "example-tool",
    "description": "处理上传的文件并保存结果。",
    "kind": "script",
    "entrypoint": "python main.py",
    "needsFileMount": true,
    "dependencies": { "libraries": ["pandas"], "domains": [] },
    "files": ["main.py", "requirements.txt"],
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "input": {
      "type": "object",
      "properties": { "filename": { "type": "string", "format": "file", "title": "输入文件" } },
      "required": ["filename"]
    },
    "env": { "type": "object", "properties": {} },
    "output": { "type": "files", "dir": "/root/io" }
  }

manifest.json 必须是合法 JSON。字符串值内禁止出现未转义的英文双引号。

needsFileMount — 当工具的输入或输出涉及文件，manifest 中必须设 "needsFileMount": true。
设为 true 后运行时会挂 /root/io，正确的路径要拼上平台预算好的相对子目录：
   /root/io/<_sopFileDir>/<filename>

写完 manifest 后，把面向用户的使用说明写到 /root/workspace/.crewmeld-studio/README.md。
同时写一个标准启动脚本 /root/workspace/start.sh（workspace 根，不是 .crewmeld-studio/）。

kind=script —— JSON 参数通过 stdin 灌入（不传命令行参数）。用 json.load(sys.stdin) 读取。处理完将结果以 JSON 格式打印到 stdout。
kind=service —— service.type 必须设为 json、http 或 sse，默认监听端口 9876。JSON 服务从请求体读参数；HTTP 服务保留常规方法/路由并打包相对资源；SSE 服务逐条刷新 text/event-stream 事件。用 exec python3 main.py 启动。

连接类工具（数据库 / 第三方系统）—— 使用 connectorType 字段（JSON 对象 {"type": "...", "subtype": "..."}），从平台注入的 CONN_* 环境变量读取连接信息/凭据。禁止自造凭据环境变量。

收尾前逐项自检，发现问题立即修正：
1. 输出语言：所有面向操作者的输出（对话回复、todo、状态说明、本次自检结论）一律简体中文。
2. 代码正确性：做一次 dry import / 语法检查确认无导入/语法错误；不要 pip install 或启动服务（chat 沙箱出口网络受限，装不上是预期）。
3. 文件 IO 契约（涉及文件时）：
   - 代码先从输入取 \`_sopFileDir\`，再拼 open(f"/root/io/{sop_file_dir}/{filename}")；
   - 没有裸写 open("/root/io/<文件名>")（缺子目录前缀会找不到文件）；
   - 没有用 \`_sopExecutionId\` 拼路径（它没有日期段）；
   - 输出文件写到同一 /root/io/{sop_file_dir}/ 子目录，response 只返回相对文件名。
4. manifest 字段契约：
   - manifest.json 是合法 JSON、必填字段齐全；
   - \`files\` 数组与实际 workspace 文件完全一致（无遗漏、无失效项，不含 .crewmeld-studio/ 内容）；
   - 涉及文件时已设 "needsFileMount": true；
   - 文件输入参数用 { "type": "string", "format": "file" }，文件输出用 { "type": "files", "dir": "/root/io" }（或 image / pdf）；
   - \`_sopFileDir\` / \`_sopExecutionId\` 没有出现在 manifest.input.properties。
5. 运行约定：
   - kind=script 用 json.load(sys.stdin) 读参数、stdout 出 JSON 结果；
   - kind=service 使用声明的 service.type/path/method + 默认端口 9876 + exec python3 启动，与 manifest.service 声明一致；
   - start.sh 能启动 manifest.entrypoint 声明的命令。
6. 凭据与版本控制：
   - 连接类工具用 connectorType 字段并从 CONN_* 环境变量读凭据，没有自造凭据 env；
   - 全程未执行任何 git 操作（git add / commit / push / tag 等）。
7. 产物完整性：代码 / manifest / README.md / start.sh 各就各位（README 与 start.sh 在 workspace 根，manifest 在 .crewmeld-studio/）；有 pip 依赖时 requirements.txt 齐全且与 dependencies.libraries 对应。
交付前把这次自检的结论用一小段话告诉操作者（简体中文）。
`.trim()
