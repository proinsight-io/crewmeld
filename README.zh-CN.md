# CrewMeld

>🌐 [English](./README.md) | **简体中文**

企业 AI 数字员工平台。提供 AI Agent 的编排、部署与运行能力，支持私有化部署。

- 产品官网：<https://crewmeld.ai/>
- 用户手册：<https://proinsight.gitbook.io/crewmeld/v-1.0.0-cn>

---

## 目录

- [产品功能](#产品功能)
- [技术架构](#技术架构)
- [快速开始](#快速开始)
- [部署](#部署)
- [License](#license)

---

## 产品功能

![产品概览](./intro/zh/01-Overview.gif)

平台围绕三类资产组织 AI 能力：数字员工、SOP、工具。

### 资产模型：员工 · SOP · 工具

| 资产 | 职责 | 编排粒度 | 创建方式 |
|------|------|---------|---------|
| 数字员工 | 任务执行主体 | — | 上岗向导 |
| SOP | 多角色协作流程，支持跨小时/跨天 | 环节级 | 可视化画布 |
| 工具 | 原子能力，毫秒至秒级 | 操作级 | 模板实例化 / OpenAPI 导入 |

依赖关系：工具被数字员工绑定与按需调用；数字员工与人类员工被 SOP 编排为多角色协作流程。

### 1. 数字员工管理

![数字员工管理](./intro/zh/02-DigitalEmployees.gif)

一个数字员工包含身份信息（名称、头像、角色类型、人格）、工具实例、LLM 模型配置、知识库绑定、系统连接、运行状态（待命/活跃/暂停/异常）以及运营指标（任务完成量、成功率、平均耗时）。

上岗流程：

1. 选择角色或直接创建 — 从角色库选择预置角色，或跳过直接填写基本信息
2. 基本信息 — 名称、描述、人格设定（自动预填自所选角色）
3. 工具绑定 — 为员工挂载所需工具（仅已部署的实例可绑定）
4. 知识库绑定 — 关联文档知识库（多对多）
5. 模型配置 — 选择 LLM 供应商与模型
6. 确认上岗 — 汇总信息确认，初始状态为「待命」

### 2. SOP 协作编排

![SOP 协作编排](./intro/zh/03-SOP.gif)

SOP 承担多角色协作流转、触发与调度、人工确认环节三类职责。

环节类型：

| 类型 | 执行者 | 说明 |
|------|--------|------|
| 数字员工 | 数字员工 | 调用某数字员工，使用其工具和知识库执行任务 |
| 人类员工 | 人类员工 | 由人类执行操作 |
| 人工确认 | 人类员工 | 流程暂停等待确认后继续 |
| 条件分支 | — | 多路路由 |

执行状态机包含 8 种状态：待执行、运行中、完成，以及人工等待（断点恢复）、超时、错误、失败、取消。所有状态转换经过校验，非法转换被拒绝。

触发方式：

| 类型 | 实现 |
|------|------|
| 定时触发 | cron 表达式 + 队列调度 |
| 事件触发 | 渠道消息 / Webhook 回调 |
| 手动触发 | 管理台执行按钮 / Open API |

断点恢复（人工确认场景）：流程到达人工确认节点时引擎暂停，完整状态快照持久化到数据库；通过审批人配置的渠道（飞书/企微/钉钉审批卡片、邮件 HTML 卡片）发送通知；审批人通过链接免登录决策；引擎从断点恢复，支持先到先得的并发控制。

超时机制：环节级超时自动增加「超时」出口；SOP 级最长执行时长默认 24 小时，可调。

可视化画布编辑器：拖拽节点编排、连线定义流转、节点属性面板（执行者/超时/重试）、版本管理（每次保存生成新版本）。

执行追踪：执行记录列表（按 SOP 类型/时间/状态筛选）、环节级时间线、流式日志、待处理审批队列。

### 3. 工具模板与实例体系

![工具模板与实例体系](./intro/zh/04-Tools.gif)

工具采用模板与实例两级管理，代码与配置分离：同一模板可创建多个实例，各自持有不同参数和密钥，独立部署运行。

模板来源：

- 官方预置 — 平台预置
- 用户安装 — 用户创建或通过 ZIP 包导入

ZIP 导入导出（跨环境迁移）：标记为「机密」的环境变量在导出时清空，导入后手动填写，避免密钥泄漏。

OpenSandbox 部署：工具实例代码运行在独立的 OpenSandbox 容器中（Docker 或 Kubernetes 运行时），与平台主进程隔离；支持 JavaScript 与 Python；沙箱故障不影响平台稳定性。

### 4. 渠道接入

平台通过统一的渠道插件体系接入下列通讯平台。新渠道可通过适配器、卡片构建器、发送器三件套扩展。

| 渠道 | 功能覆盖 |
|------|---------|
| 企业微信 | 消息收发 + 加解密 + 富文本卡片 + 审批通知 |
| 钉钉 | 消息收发 + 机器人推送 + 审批卡片 |
| 飞书 | 消息收发 + AES 加解密 + 卡片 + 按员工路由 |
| 微信公众号 | 标准公众号消息接入 |
| 邮件 | SMTP 发送 + IMAP 接收 + HTML 审批卡片 |
| 短信 | 通过统一插件接口接入 |
| Telegram | Bot 消息收发 |
| Discord | Bot 消息收发 |

### 5. 对话系统

用户与数字员工的交互通道：

- 多渠道统一 — Web、上述 8 个渠道、Open API 共用同一对话引擎入口
- 多轮对话 — 会话上下文持久化，支持多轮追问和参数收集
- SOP 触发 — 通过对话直接触发 SOP 执行
- 流式响应 — SSE 与 WebSocket 双通道实时推送
- Token 统计 — 每条消息记录 token 使用量
- 历史记录浏览 — 双面板布局（左侧对话列表 + 渠道标签，右侧消息详情），按渠道筛选
- 逻辑删除 — 对话删除为软删除，保留可追溯性
- 自动语言适配 — 基于消息语言自动检测，LLM 回复使用用户消息的语言

### 6. 知识库（RAGFlow）

平台知识库管理 UI 对接 RAGFlow（独立 Docker 服务，版本 v0.23.1），提供文档解析、检索、OCR 与员工绑定能力。

集成能力：

- 多格式文档上传 — PDF、Word、Excel、PPT、扫描件
- 解析进度实时显示 — 未开始/解析中/完成/失败 + 百分比 + 切片数量
- 解析控制 — 停止/重启解析操作
- 混合检索 — 向量检索（基于内置 bge-m3 中文模型）与 BM25 关键词检索融合
- 多对多绑定 — 一个员工可绑定多个知识库，一个知识库可被多个员工使用
- 搜索日志 — 搜索行为持久化，作为引用分析与召回率优化的基础数据

### 7. LLM Provider

平台已适配以下 LLM Provider，员工可在管理台直接选择并切换：

OpenAI、Anthropic、Google、通义千问、DeepSeek、文心一言、混元、月之暗面（Kimi）、智谱、豆包、MiniMax、Ollama（本地推理）、vLLM（自部署高性能推理）。

编码模型 —— 专供工具开发工作台（Dev Studio）的 Claude Code 式编码：Claude 编程、Kimi 编程、通义编程、千帆编程。

凭据加密存储，可针对不同员工分配不同模型与不同账号。

### 8. 定时任务

可视化定时任务管理，时区可配置。

- 创建/编辑 — 选择目标 SOP、设置 cron 表达式、设置时区，系统自动注册队列任务并显示「下次执行时间」
- 手动触发 — 管理台一键触发，无需等待 cron 到期
- 删除 — 同步从调度队列移除，无残留任务

### 9. 合规与审计

- RBAC 三档角色 — 超管（super_admin）/ 管理员（admin）/ 普通成员（member），所有变更操作经权限校验
- 审计日志 — 所有变更操作自动记录操作人、时间、前后值
- 加密存储 — LLM 凭据、系统连接密钥使用平台级密钥加密
- 结构化日志 — 输出结构化日志，便于外部聚合
- 多语言 UI — 支持简体中文与英文，根据浏览器/Cookie 自动切换

---

## 技术架构

### 五层产品架构

```
┌─────────────────────────────────────────────────────────────┐
│  触发层 │ 8 渠道（企微/钉钉/飞书/WxOA/邮件/短信/TG/Discord） │
│         │ + CRON 定时 + 手动触发 / Open API                  │
└─────────────────────────────────────────────────────────────┘
                          ↓ 消息 / 触发事件
┌─────────────────────────────────────────────────────────────┐
│  SOP 协作编排层 │ 数字员工 + 人类员工 + 人工确认 + 条件分支  │
└─────────────────────────────────────────────────────────────┘
                          ↓ 调度数字员工节点
┌─────────────────────────────────────────────────────────────┐
│  数字员工层 │ 对话管理 + 意图理解路由 + 工具调度             │
└─────────────────────────────────────────────────────────────┘
                          ↓ LLM 决策调用工具
┌─────────────────────────────────────────────────────────────┐
│  工具层 │ OpenSandbox 隔离 Node.js / Python 进程，代码隔离   │
│         │ AI 编写程序，通过用户添加的「连接」操作外部系统    │
└─────────────────────────────────────────────────────────────┘
                          ↓ 通过用户添加的连接访问
┌─────────────────────────────────────────────────────────────┐
│  外部系统层 │ 主流数据库 + 自定义 API                        │
│             │ 用户自有数据库 / CRM / Shopify / ERP / OA ...  │
└─────────────────────────────────────────────────────────────┘
                          ↓ 平台自身依赖
┌─────────────────────────────────────────────────────────────┐
│  基础设施层 │ PostgreSQL + Redis + MinIO + RAGFlow + LLM     │
└─────────────────────────────────────────────────────────────┘
```

### 核心技术栈

| 层次 | 技术 |
|------|------|
| 语言 | TypeScript 5.7（全栈，严格模式） |
| 运行时 | Bun 1.3.9 / Node.js >= 20 |
| 框架 | Next.js 16 App Router + React 19 |
| UI | Tailwind CSS + shadcn/ui + Radix UI + ReactFlow |
| 数据库 | PostgreSQL 17 |
| 缓存与消息 | Redis（>= 5，建议 7） |
| 任务队列 | BullMQ + Croner 定时调度 |
| 实时通信 | Socket.IO + Redis Adapter |
| 对象存储 | MinIO（S3 兼容协议） |
| 知识库 | RAGFlow v0.23.1（独立服务） |
| 工具沙箱 | OpenSandbox（Docker / Kubernetes 运行时） |
| 认证 | better-auth |
| 部署 | Docker Compose / Helm / Kubernetes |
| 测试 | Vitest 单元测试 + Playwright E2E |
| 代码规范 | Biome + lint-staged + Husky |

### 目录结构

```
crewmeld/
├── apps/crewmeld/            # 主应用（Next.js）
│   ├── app/(employee)/       # 数字员工管理台 UI
│   ├── app/api/employee/     # BFF 路由
│   ├── providers/            # LLM 适配器
│   ├── tools/                # HTTP 工具实现
│   └── lib/                  # 核心服务层（SOP/对话/渠道/K8s/i18n）
├── packages/
│   ├── db/                   # 数据库 Schema + 迁移
│   └── logger/               # 结构化日志
├── helm/crewmeld/            # K8s Helm Chart
├── scripts/                  # 运维 + CI 检查脚本
├── tests/e2e/                # Playwright E2E 测试
├── build.{sh,bat,ps1}        # 跨平台镜像构建脚本
├── start.{sh,bat,ps1}        # 跨平台启动脚本
└── docker-compose*.yml       # 4 份 compose 文件
```

---

## 快速开始

### 一键启动（Docker 全栈 + 应用）

```bash
./start.sh --profile opensandbox-docker --profile minio --profile ragflow --profile ollama
# Windows cmd:  start.bat --profile opensandbox-docker --profile minio --profile ragflow --profile ollama
# PowerShell:   .\start.ps1 --profile opensandbox-docker --profile minio --profile ragflow --profile ollama
```

`start` 脚本自动处理 `.env` 初始化、secrets 生成与 `docker compose up`，profile 可自由组合。

### 本地开发（不走 Docker 主应用）

```bash
# 1. 安装依赖（需 Bun 1.3.9+）
bun install

# 2. 启动基础服务（PostgreSQL 17 + Redis 7）
docker compose up -d db redis

# 3. 启动开发服务器（Next.js + Socket.IO + 后台任务）
bun run dev:full
```

访问 <http://localhost:6100>。首次启动可走 `/setup` 向导创建超管账号，或执行 seed（见下）。

### 环境变量

必需配置（无默认值，须显式设置）：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `NEXT_PUBLIC_APP_URL` | 应用基础 URL（默认 `http://localhost:6100`） |
| `REDIS_URL` | 队列与实时通信集群所需 |

Secrets（使用 `start.sh` / `start.bat` / `start.ps1` 启动时会自动随机生成并写入 `.env`）：

`POSTGRES_PASSWORD` / `BETTER_AUTH_SECRET` / `ENCRYPTION_KEY` / `INTERNAL_API_SECRET`

工具沙箱依赖（仅当启用 OpenSandbox 工具沙箱时需要）：

| 变量 | 说明 |
|------|------|
| `OPENSANDBOX_SERVER_URL` | OpenSandbox server 地址（如 `http://opensandbox-server:30080`） |
| `OPENSANDBOX_API_KEY` | OpenSandbox API key |
| `CREWMELD_SANDBOX_IMAGE` | 沙箱镜像（默认 `proinsight/crewmeld-coder:latest`） |
| `CREWMELD_SANDBOX_VOLUME_ROOT` / `CREWMELD_BFF_VOLUME_ROOT` | 共享沙箱卷根目录 |
| `DEV_STUDIO_ENABLED` | 启用工具开发工作台启动期校验 |

### 测试用户（E2E seed）

平台预置 3 档 RBAC 角色用户，供 E2E 测试与本地验证使用。

| Email | 密码 | 平台角色 |
|-------|------|---------|
| `admin@crewmeld.local` | `Crewmeld@2026` | super_admin |
| `ops@crewmeld.local` | `Ops@2026` | admin |
| `viewer@crewmeld.local` | `Viewer@2026` | member |

E2E 运行时自动插入；手动插入分两种场景：

场景 A：本地 dev 栈（数据库映射主机 5432 端口）

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/crewmeld" \
  bun run --cwd packages/db seed/e2e-seed.ts
```

场景 B：全栈（数据库仅走 docker 内部网络）

```bash
# 在应用容器内执行
# 注意：首次需删除 broken symlinks（Dockerfile 构建遗留的 Windows 路径问题）
docker exec -u root crewmeld-crewmeld-1 rm -rf /app/packages/db/node_modules
docker exec -w /app/packages/db crewmeld-crewmeld-1 bun run seed/e2e-seed.ts
```

仅用于开发与测试环境；生产环境不应执行此 seed。

### 主要命令

| 命令 | 用途 |
|------|------|
| `bun run dev:full` | 启动开发服务器（6100 端口）+ Socket.IO |
| `bun run build` | 构建生产包（需要真实 `.env`） |
| `bun run test` | 运行单元测试（Vitest） |
| `bunx playwright test` | 运行 mock 模式 E2E 测试 |
| `E2E_LIVE=1 bunx playwright test --project=chromium-live` | 运行 live 模式 E2E（需密钥/k3s） |
| `bunx drizzle-kit generate` | 生成数据库迁移 |
| `bunx drizzle-kit studio` | 打开数据库可视化 |
| `bun run lint:helm` | Helm chart 严格模式 lint |
| `./build.sh <version>` | 构建并标记镜像（加 `--push` 推送） |
| `./start.sh --profile <p>...` | 启动 docker compose |

---

## 部署

提供两种部署形态：Docker Compose（适用于开发与小规模）和 Helm（适用于生产 Kubernetes）。

### Docker Compose

使用 `start.sh` / `start.bat` / `start.ps1` 包装脚本会自动生成 secrets 后拉起服务：

```bash
./start.sh                                                                    # 最小栈（默认 profile）
./start.sh --profile opensandbox-docker --profile minio                       # 加工具沙箱
./start.sh --profile ragflow                                                  # 加知识库
./start.sh --profile opensandbox-docker --profile minio --profile ragflow     # 全部组件
```

Windows 将 `./start.sh` 替换为 `start.bat`（cmd）或 `.\start.ps1`（PowerShell）。

直接使用 `docker compose`（跳过 start 包装）：

```bash
# 最小栈（默认 profile）
docker compose up -d

# 全栈（MinIO + RAGFlow + OpenSandbox 工具沙箱，docker 运行时）
docker compose --profile minio --profile ragflow --profile opensandbox-docker up -d
# OpenSandbox 也提供 k3s 运行时 —— 换成 --profile opensandbox

# 加本地 Ollama（可与全栈组合）
docker compose --profile ollama up -d                  # NVIDIA GPU（默认）
docker compose --profile ollama-cpu up -d              # CPU-only
docker compose --profile ollama-setup up model-setup   # 一次性拉 gemma4:e2b（最小 Gemma 4，多模态 ~7.2GB）
```

#### Compose 文件矩阵

| 文件 | 用途 |
|------|------|
| `docker-compose.yml` | 主编排文件（profile 控制完整栈） |
| `docker-compose.dev.yml` | 开发叠加层（源码挂载 + 调试端口） |
| `docker-compose.local.yml` | 本地集成测试 |
| `docker-compose.prod.yml` | 生产叠加层（TLS + 资源限额） |

#### Profile 组合矩阵

最小内存基于 2026-04-23 实测（应用镜像 510MB，空闲态）。生产实际占用会随并发与模型加载上升。

| 场景 | 命令 | 最小内存 |
|------|------|---------|
| 最小（仅应用 + DB + Redis） | `docker compose up -d` | ~500 MB |
| 加工具沙箱 | `--profile opensandbox-docker --profile minio` | ~1.5 GB |
| 加知识库 | `--profile ragflow` | ~6 GB |
| 全部组件 | `--profile opensandbox-docker --profile minio --profile ragflow` | ~7 GB |
| 全部组件 + 本地 Ollama | 上面 + `--profile ollama` 或 `--profile ollama-cpu` | ~7 GB + 模型大小 |

### Helm

```bash
helm install crewmeld ./helm/crewmeld \
  --values ./helm/crewmeld/examples/production.yaml \
  --namespace crewmeld --create-namespace
```

Helm Chart 已通过 `helm lint --strict`，覆盖：

- 应用 Deployment + Service + Ingress
- 内置 PostgreSQL 17 + Redis 7
- MinIO 对象存储（S3 兼容）+ 自动创建 6 个业务存储桶
- RAGFlow 与 Ollama 可选组件
- Secrets 模板（数据库连接串、Auth 密钥、加密密钥、模型 API Key）
- nginx 反向代理 + SSL（生产 overlay）

---

## License

CrewMeld 采用基于 Apache License 2.0 修改版的开源协议，附加以下条件：

1. 商业使用限制：可用于商业用途，包括作为后端服务或企业应用开发平台。下列情形需获得商业授权：

   - 多租户服务：未经书面授权不得使用 CrewMeld 源码运营多租户环境（一个 tenant = 一个 workspace）
   - LOGO 与版权信息：使用 CrewMeld 前端时不得移除或修改控制台/应用中的 LOGO 或版权信息

2. 贡献者条款：作为贡献者，您同意：

   - 制作方可根据需要调整开源协议为更严格或更宽松
   - 贡献的代码可被用于商业用途，包括但不限于云业务

除上述附加条件外，其他权利与限制遵循 Apache License 2.0。

完整协议条款详见根目录 [LICENSE](./LICENSE) 文件，第三方依赖声明见 [NOTICE.zh-CN.md](./NOTICE.zh-CN.md)（英文版：[NOTICE.md](./NOTICE.md)）。
