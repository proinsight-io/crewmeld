-- Migration: seed OpenClaw system tool template
-- Date: 2026-05-19
-- Purpose: register OpenClaw as a system-level tool template that doesn't require K8s deployment.
-- Tool instances of this template get auto-marked as "deployed" by the instances POST handler.

INSERT INTO tools (
  id,
  name,
  description,
  version,
  code,
  parameters,
  category,
  author,
  language,
  source,
  connector_type,
  created_by,
  created_at,
  updated_at
) VALUES (
  'system-openclaw',
  'OpenClaw',
  E'OpenClaw AI 网关。把任务委派给 OpenClaw 处理，适合编码、自动化、执行代码、调用外部 Agent。任务异步执行，本工具立即返回 task_id，真实结果稍后追加到对话。\n\n已验证可用的 tool：\n- sessions_list：列出当前 OpenClaw 会话\n\n其他工具（如 chat、code 等）按 OpenClaw 网关支持的工具名调用。',
  'V1.0.20260519',
  NULL,
  '{"type":"object","properties":{"tool":{"type":"string","description":"OpenClaw 工具名（如 sessions_list、chat、code）"},"args":{"type":"object","description":"传给 OpenClaw 工具的参数","additionalProperties":true}},"required":["tool"]}'::jsonb,
  'System',
  'CrewMeld',
  'javascript',
  'installed',
  '{"type":"openclaw"}'::jsonb,
  'system',
  NOW(),
  NOW()
) ON CONFLICT (id) DO NOTHING;
