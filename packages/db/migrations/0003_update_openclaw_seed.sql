-- Migration: update OpenClaw system tool template to ask_openclaw(message) shape
-- Date: 2026-05-20
-- Purpose: switch from {tool, args} passthrough to a simple ask_openclaw(message)
--          tool that maps to OpenClaw's official /v1/chat/completions endpoint.
--          The LLM no longer guesses OpenClaw tool names — it just forwards a
--          question to OpenClaw and the integration handles the rest.

UPDATE tools
SET
  description = E'OpenClaw AI 网关。把问题或任务交给 OpenClaw 处理，OpenClaw 内置 agent 会返回回答。\n\n适合：编码任务、自动化、查询、需要 OpenClaw 内部工具（如 web 搜索、文件操作、技能等）处理的请求。\n\n本工具异步执行——立即返回 task_id，OpenClaw 的真实回答稍后追加到对话。',
  parameters = '{
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "description": "要交给 OpenClaw 处理的问题或任务描述"
      },
      "model": {
        "type": "string",
        "description": "可选：指定 OpenClaw 内部 agent（如 \"openclaw/agent-name\"）。不填用连接默认 agent。"
      }
    },
    "required": ["message"]
  }'::jsonb,
  version = 'V2.0.20260520',
  updated_at = NOW()
WHERE id = 'system-openclaw';
