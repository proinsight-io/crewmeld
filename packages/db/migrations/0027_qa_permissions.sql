INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order)
VALUES
  ('knowledge:qa:view', '查看QA问答', '查看QA问答、热门问题和未回答问题', 'knowledge', 1040),
  ('knowledge:qa:create', '新增QA问答', '新增QA问答记录', 'knowledge', 1050),
  ('knowledge:qa:update', '编辑QA问答', '编辑QA问答内容', 'knowledge', 1060),
  ('knowledge:qa:import', '导入QA问答', '预览和确认导入QA问答', 'knowledge', 1070),
  ('knowledge:qa:export', '导出QA问答', '导出QA问答数据', 'knowledge', 1080),
  ('knowledge:qa:toggle', '启停QA问答', '启用或停用QA问答', 'knowledge', 1090),
  ('knowledge:qa:delete', '删除QA问答', '删除QA问答记录', 'knowledge', 1100),
  ('knowledge:qa:sync', '同步QA问答', '同步QA问答到RAGFlow', 'knowledge', 1110),
  ('knowledge:question:triage', '治理问题', '治理热门问题和未回答问题', 'knowledge', 1120)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.platform_role_permissions (id, role, permission_code)
SELECT
  'seed-qa-admin-' || replace(permission_code, ':', '-'),
  'admin'::platform_role,
  permission_code
FROM unnest(ARRAY[
  'knowledge:qa:view',
  'knowledge:qa:create',
  'knowledge:qa:update',
  'knowledge:qa:import',
  'knowledge:qa:export',
  'knowledge:qa:toggle',
  'knowledge:qa:delete',
  'knowledge:qa:sync',
  'knowledge:question:triage'
]) AS permissions(permission_code)
ON CONFLICT (role, permission_code) DO NOTHING;
