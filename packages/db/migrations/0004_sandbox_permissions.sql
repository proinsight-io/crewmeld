-- Backfills the sandbox:view / sandbox:edit permission seeds for databases
-- initialised before commit 9cd01e9. The same INSERTs live in init.sql for
-- fresh installs; the ON CONFLICT clauses make this migration idempotent on
-- any database (new or old).
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at)
VALUES ('sandbox:view', '查看沙箱设置', '查看沙箱预装库与网络白名单配置', 'sandbox', 1300, NOW())
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at)
VALUES ('sandbox:edit', '修改沙箱设置', '修改沙箱预装库、网络白名单与出网模式', 'sandbox', 1310, NOW())
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by)
VALUES ('seed-sandbox-view-super', 'super_admin', 'sandbox:view', NOW(), NULL)
ON CONFLICT (role, permission_code) DO NOTHING;--> statement-breakpoint
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by)
VALUES ('seed-sandbox-edit-super', 'super_admin', 'sandbox:edit', NOW(), NULL)
ON CONFLICT (role, permission_code) DO NOTHING;--> statement-breakpoint
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by)
VALUES ('seed-sandbox-view-admin', 'admin', 'sandbox:view', NOW(), NULL)
ON CONFLICT (role, permission_code) DO NOTHING;
