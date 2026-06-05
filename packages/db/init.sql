-- ============================================================
-- CrewMeld — Database initialization script
-- Generated: 2026-04-24
-- Source: packages/db/migrations/0000_baseline.sql (schema)
--       + RBAC seed pulled from the active dev database
--       + static 3 dev accounts (see README.md table)
--
-- Applied by:
--   - Postgres container first boot (docker-entrypoint-initdb.d)
--   - CI (.github/workflows/ci.yml)
--   - Manual: psql ... -f packages/db/init.sql
--
-- Idempotency:
--   - Schema section (CREATE TABLE / TYPE / INDEX) assumes empty DB on
--     first apply. Re-applying on a non-empty DB fails at CREATE TABLE
--     (no IF NOT EXISTS in the baseline migration).
--   - Seed section (RBAC + 3 dev accounts) uses ON CONFLICT clauses so
--     it is safe to re-run on an already-seeded DB.
--
-- To regenerate from scratch:
--   1. bunx --cwd packages/db drizzle-kit generate --name=baseline
--   2. pg_dump ... --table=platform_permission_defs
--                 --table=platform_role_permissions
--                 --data-only --column-inserts > .tmp/rbac_seed.sql
--   3. bun run packages/db/scripts/gen-seed-hashes.ts  (one-shot)
--   4. Concatenate per scripts/build-init-sql.sh
--
-- When better-auth is bumped to a major version, re-run step 3 and
-- replace the 3 hash strings below.
-- ============================================================


CREATE TYPE "public"."alert_category" AS ENUM('task_failure', 'employee_error', 'system_error', 'performance', 'security');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('web', 'wecom', 'dingtalk', 'feishu', 'discord', 'telegram', 'api', 'wxoa', 'email');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('standby', 'active', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."permission_type" AS ENUM('admin', 'write', 'read');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('super_admin', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."sandbox_run_status" AS ENUM('pending', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."sandbox_run_type" AS ENUM('node_test', 'workflow_run', 'sop_run');--> statement-breakpoint
CREATE TYPE "public"."sop_execution_status" AS ENUM('pending', 'running', 'paused_for_human', 'completed', 'timed_out', 'error', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sop_node_status" AS ENUM('pending', 'running', 'completed', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."sop_pause_decision" AS ENUM('approved', 'rejected', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."sop_pause_status" AS ENUM('waiting', 'decided', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."sop_trigger_type" AS ENUM('scheduled', 'event', 'manual');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'success', 'failed', 'hitl_waiting');--> statement-breakpoint
CREATE TYPE "public"."task_trigger_type" AS ENUM('scheduled', 'manual', 'event', 'webhook', 'api', 'sop', 'conversation');--> statement-breakpoint
CREATE TYPE "public"."work_log_type" AS ENUM('action', 'decision', 'tool_call', 'llm_call', 'error');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anomaly_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"category" "alert_category" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"employee_id" text,
	"employee_name" text,
	"task_execution_id" text,
	"error_message" text,
	"error_stack" text,
	"metadata" jsonb DEFAULT '{}',
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_by" text,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"type" text DEFAULT 'personal' NOT NULL,
	"last_used" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "api_key_key_unique" UNIQUE("key"),
	CONSTRAINT "workspace_type_check" CHECK ((type = 'workspace' AND workspace_id IS NOT NULL) OR (type = 'personal' AND workspace_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"actor_name" text,
	"actor_email" text,
	"resource_name" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}',
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"external_user_id" text NOT NULL,
	"external_session_id" text,
	"conversation_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"tool_name" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" "conversation_channel" DEFAULT 'web' NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"title" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"stat_date" date NOT NULL,
	"total_tasks" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"hitl_count" integer DEFAULT 0 NOT NULL,
	"avg_duration_ms" integer,
	"tokens_consumed" integer DEFAULT 0 NOT NULL,
	"cost_rmb" numeric(12, 4) DEFAULT '0' NOT NULL,
	"custom_metrics" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_employees" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar" text,
	"description" text,
	"block_type" text NOT NULL,
	"status" "employee_status" DEFAULT 'standby' NOT NULL,
	"workflow_id" text,
	"model_config_id" text,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"schedule_config" jsonb,
	"persona" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_platform_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" "platform_role" DEFAULT 'member' NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_skill_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_workflow_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_employees" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"contact_methods" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"key" text PRIMARY KEY NOT NULL,
	"result" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"inviter_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"api_key_encrypted" text,
	"api_endpoint" text,
	"model_name" text,
	"default_params" jsonb DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_result" text,
	"last_test_latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "model_usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"tokens_total" integer DEFAULT 0 NOT NULL,
	"cost_input" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cost_output" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cost_total" numeric(12, 6) DEFAULT '0' NOT NULL,
	"duration_ms" integer,
	"workflow_id" text,
	"workspace_id" text,
	"user_id" text,
	"employee_id" text,
	"status" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" json,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_group" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_add_new_members" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_group_member" (
	"id" text PRIMARY KEY NOT NULL,
	"permission_group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"permission_type" "permission_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_permission_defs" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_role_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"role" "platform_role" NOT NULL,
	"permission_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"persona" text,
	"category" text DEFAULT 'general' NOT NULL,
	"icon" text,
	"block_type" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_type" "sandbox_run_type" NOT NULL,
	"status" "sandbox_run_status" DEFAULT 'pending' NOT NULL,
	"workflow_id" text,
	"sop_definition_id" text,
	"target_node_id" text,
	"trigger_data" jsonb,
	"policy" jsonb,
	"node_results" jsonb DEFAULT '[]',
	"intercepted_calls" jsonb DEFAULT '[]',
	"execution_path" jsonb DEFAULT '[]',
	"mock_decisions" jsonb DEFAULT '{}',
	"error_message" text,
	"total_duration_ms" integer,
	"total_tokens_used" integer DEFAULT 0,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sop_definition_id" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"trigger_data" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"auto_connect" boolean DEFAULT true NOT NULL,
	"telemetry_enabled" boolean DEFAULT true NOT NULL,
	"email_preferences" json DEFAULT '{}' NOT NULL,
	"billing_usage_notifications_enabled" boolean DEFAULT true NOT NULL,
	"show_training_controls" boolean DEFAULT false NOT NULL,
	"super_user_mode_enabled" boolean DEFAULT true NOT NULL,
	"error_notifications_enabled" boolean DEFAULT true NOT NULL,
	"snap_to_grid_size" integer DEFAULT 0 NOT NULL,
	"show_action_bar" boolean DEFAULT true NOT NULL,
	"copilot_enabled_models" jsonb DEFAULT '{}' NOT NULL,
	"copilot_auto_allowed_tools" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "sop_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" "sop_trigger_type" DEFAULT 'manual' NOT NULL,
	"trigger_config" jsonb DEFAULT '{}' NOT NULL,
	"nodes" jsonb DEFAULT '[]' NOT NULL,
	"edges" jsonb DEFAULT '[]' NOT NULL,
	"sop_timeout_minutes" integer DEFAULT 1440 NOT NULL,
	"max_rejection_cycles" integer DEFAULT 3 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sop_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"sop_definition_id" text,
	"sop_version" integer NOT NULL,
	"triggered_by" text NOT NULL,
	"scheduled_task_id" text,
	"status" "sop_execution_status" DEFAULT 'pending' NOT NULL,
	"state_snapshot" jsonb DEFAULT '{}' NOT NULL,
	"trigger_data" jsonb DEFAULT '{}',
	"retry_count" integer DEFAULT 0 NOT NULL,
	"rejection_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}',
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sop_node_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_name" text NOT NULL,
	"node_type" text NOT NULL,
	"status" "sop_node_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"workflow_run_id" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"exit_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sop_pause_states" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" "sop_pause_status" DEFAULT 'waiting' NOT NULL,
	"assignee_id" text,
	"decision" "sop_pause_decision",
	"decided_by" text,
	"comment" text,
	"timeout_job_id" text,
	"expires_at" timestamp with time zone,
	"approval_token" text,
	"token_expires_at" timestamp with time zone,
	"card_response_code" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"config_encrypted" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_health_check" timestamp with time zone,
	"last_health_message_i18n" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "task_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"workflow_run_id" text,
	"sop_execution_id" text,
	"trigger_type" "task_trigger_type" NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}' NOT NULL,
	"output" jsonb,
	"input_summary" text,
	"output_summary" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_rmb" numeric(12, 4) DEFAULT '0' NOT NULL,
	"duration_ms" integer,
	"error_message" text,
	"requires_review" boolean DEFAULT false NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"keys_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"name" text NOT NULL,
	"connection_id" text,
	"preset_params" jsonb,
	"env_vars" jsonb,
	"deploy" jsonb,
	"published_as_api" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text DEFAULT 'V1.0.0' NOT NULL,
	"code" text,
	"parameters" jsonb,
	"preset_params" jsonb,
	"category" text,
	"author" text,
	"language" text DEFAULT 'javascript' NOT NULL,
	"source" text DEFAULT 'installed' NOT NULL,
	"url" text,
	"deploy" jsonb,
	"env_vars" jsonb,
	"api_doc" text,
	"connector_type" jsonb,
	"needs_file_mount" boolean DEFAULT false NOT NULL,
	"package_sha256" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"stripe_customer_id" text,
	"is_super_user" boolean DEFAULT false NOT NULL,
	"approval_status" text DEFAULT 'approved' NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"log_type" "work_log_type" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"billed_account_user_id" text NOT NULL,
	"allow_personal_api_keys" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_files" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"context" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_files_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_alerts" ADD CONSTRAINT "anomaly_alerts_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_employees" ADD CONSTRAINT "digital_employees_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_connections" ADD CONSTRAINT "employee_connections_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_connections" ADD CONSTRAINT "employee_connections_connection_id_system_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."system_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_platform_roles" ADD CONSTRAINT "employee_platform_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_platform_roles" ADD CONSTRAINT "employee_platform_roles_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skill_bindings" ADD CONSTRAINT "employee_skill_bindings_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_workflow_bindings" ADD CONSTRAINT "employee_workflow_bindings_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group" ADD CONSTRAINT "permission_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group" ADD CONSTRAINT "permission_group_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group_member" ADD CONSTRAINT "permission_group_member_permission_group_id_permission_group_id_fk" FOREIGN KEY ("permission_group_id") REFERENCES "public"."permission_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group_member" ADD CONSTRAINT "permission_group_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group_member" ADD CONSTRAINT "permission_group_member_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_permission_code_platform_permission_defs_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."platform_permission_defs"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_sop_definition_id_sop_definitions_id_fk" FOREIGN KEY ("sop_definition_id") REFERENCES "public"."sop_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_executions" ADD CONSTRAINT "sop_executions_sop_definition_id_sop_definitions_id_fk" FOREIGN KEY ("sop_definition_id") REFERENCES "public"."sop_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_node_executions" ADD CONSTRAINT "sop_node_executions_execution_id_sop_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."sop_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_pause_states" ADD CONSTRAINT "sop_pause_states_execution_id_sop_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."sop_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_sop_execution_id_sop_executions_id_fk" FOREIGN KEY ("sop_execution_id") REFERENCES "public"."sop_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD CONSTRAINT "tool_instances_template_id_tools_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD CONSTRAINT "tool_instances_connection_id_system_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."system_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_task_id_task_executions_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_employee_id_digital_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."digital_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_billed_account_user_id_user_id_fk" FOREIGN KEY ("billed_account_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_account_on_account_id_provider_id" ON "account" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_user_provider_unique" ON "account" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "anomaly_alerts_severity_status_idx" ON "anomaly_alerts" USING btree ("severity","status");--> statement-breakpoint
CREATE INDEX "anomaly_alerts_category_idx" ON "anomaly_alerts" USING btree ("category");--> statement-breakpoint
CREATE INDEX "anomaly_alerts_employee_id_idx" ON "anomaly_alerts" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "anomaly_alerts_status_created_idx" ON "anomaly_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "anomaly_alerts_created_at_idx" ON "anomaly_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_key_workspace_type_idx" ON "api_key" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX "api_key_user_type_idx" ON "api_key" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "channel_sessions_channel_user_idx" ON "channel_sessions" USING btree ("channel","external_user_id");--> statement-breakpoint
CREATE INDEX "channel_sessions_conversation_id_idx" ON "channel_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "channel_sessions_employee_id_idx" ON "channel_sessions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "conv_messages_conversation_id_idx" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conv_messages_role_idx" ON "conversation_messages" USING btree ("role");--> statement-breakpoint
CREATE INDEX "conv_messages_created_at_idx" ON "conversation_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversations_employee_id_idx" ON "conversations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversations_channel_idx" ON "conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "conversations_last_message_at_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "daily_stats_employee_id_idx" ON "daily_stats" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "daily_stats_stat_date_idx" ON "daily_stats" USING btree ("stat_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_stats_employee_date_unique" ON "daily_stats" USING btree ("employee_id","stat_date");--> statement-breakpoint
CREATE INDEX "digital_employees_status_idx" ON "digital_employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "digital_employees_workflow_id_idx" ON "digital_employees" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "digital_employees_model_config_id_idx" ON "digital_employees" USING btree ("model_config_id");--> statement-breakpoint
CREATE INDEX "ec_employee_id_idx" ON "employee_connections" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "ec_connection_id_idx" ON "employee_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ec_unique_idx" ON "employee_connections" USING btree ("employee_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_platform_roles_user_id_unique" ON "employee_platform_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "employee_platform_roles_role_idx" ON "employee_platform_roles" USING btree ("role");--> statement-breakpoint
CREATE INDEX "employee_platform_roles_disabled_idx" ON "employee_platform_roles" USING btree ("is_disabled");--> statement-breakpoint
CREATE INDEX "esb_employee_id_idx" ON "employee_skill_bindings" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "esb_skill_id_idx" ON "employee_skill_bindings" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "esb_instance_id_idx" ON "employee_skill_bindings" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "esb_unique_instance_idx" ON "employee_skill_bindings" USING btree ("employee_id","instance_id");--> statement-breakpoint
CREATE INDEX "ewb_employee_id_idx" ON "employee_workflow_bindings" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "ewb_workflow_id_idx" ON "employee_workflow_bindings" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ewb_unique_idx" ON "employee_workflow_bindings" USING btree ("employee_id","workflow_id");--> statement-breakpoint
CREATE INDEX "human_emp_name_idx" ON "human_employees" USING btree ("name");--> statement-breakpoint
CREATE INDEX "human_emp_title_idx" ON "human_employees" USING btree ("title");--> statement-breakpoint
CREATE INDEX "idempotency_key_created_at_idx" ON "idempotency_key" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitation_organization_id_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_user_id_unique" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "member_organization_id_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "model_configs_provider_id_idx" ON "model_configs" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "model_configs_is_active_idx" ON "model_configs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "model_usage_logs_model_idx" ON "model_usage_logs" USING btree ("model");--> statement-breakpoint
CREATE INDEX "model_usage_logs_provider_idx" ON "model_usage_logs" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "model_usage_logs_created_at_idx" ON "model_usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usage_logs_workspace_id_idx" ON "model_usage_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "model_usage_logs_employee_id_idx" ON "model_usage_logs" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "model_usage_logs_model_created_at_idx" ON "model_usage_logs" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "permission_group_organization_id_idx" ON "permission_group" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "permission_group_created_by_idx" ON "permission_group" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_group_org_name_unique" ON "permission_group" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_group_org_auto_add_unique" ON "permission_group" USING btree ("organization_id") WHERE auto_add_new_members = true;--> statement-breakpoint
CREATE INDEX "permission_group_member_group_id_idx" ON "permission_group_member" USING btree ("permission_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_group_member_user_id_unique" ON "permission_group_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "permissions_user_id_idx" ON "permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "permissions_entity_idx" ON "permissions" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "permissions_user_entity_type_idx" ON "permissions" USING btree ("user_id","entity_type");--> statement-breakpoint
CREATE INDEX "permissions_user_entity_permission_idx" ON "permissions" USING btree ("user_id","entity_type","permission_type");--> statement-breakpoint
CREATE INDEX "permissions_user_entity_idx" ON "permissions" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_unique_constraint" ON "permissions" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "platform_permission_defs_category_idx" ON "platform_permission_defs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "platform_permission_defs_sort_order_idx" ON "platform_permission_defs" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_role_perms_role_perm_unique" ON "platform_role_permissions" USING btree ("role","permission_code");--> statement-breakpoint
CREATE INDEX "platform_role_perms_role_idx" ON "platform_role_permissions" USING btree ("role");--> statement-breakpoint
CREATE INDEX "roles_category_idx" ON "roles" USING btree ("category");--> statement-breakpoint
CREATE INDEX "roles_created_at_idx" ON "roles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_workflow_id_idx" ON "sandbox_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "sandbox_runs_sop_definition_id_idx" ON "sandbox_runs" USING btree ("sop_definition_id");--> statement-breakpoint
CREATE INDEX "sandbox_runs_status_idx" ON "sandbox_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sandbox_runs_run_type_idx" ON "sandbox_runs" USING btree ("run_type");--> statement-breakpoint
CREATE INDEX "sandbox_runs_created_at_idx" ON "sandbox_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_created_by_idx" ON "sandbox_runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "st_sop_definition_id_idx" ON "scheduled_tasks" USING btree ("sop_definition_id");--> statement-breakpoint
CREATE INDEX "st_is_active_idx" ON "scheduled_tasks" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "st_next_run_at_idx" ON "scheduled_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "st_created_by_idx" ON "scheduled_tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_token_idx" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sop_definitions_name_idx" ON "sop_definitions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sop_definitions_trigger_type_idx" ON "sop_definitions" USING btree ("trigger_type");--> statement-breakpoint
CREATE INDEX "sop_definitions_is_active_idx" ON "sop_definitions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sop_definitions_created_at_idx" ON "sop_definitions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sop_definitions_created_by_idx" ON "sop_definitions" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "sop_exec_definition_id_idx" ON "sop_executions" USING btree ("sop_definition_id");--> statement-breakpoint
CREATE INDEX "sop_exec_status_idx" ON "sop_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sop_exec_status_created_idx" ON "sop_executions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sop_exec_started_at_idx" ON "sop_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sop_exec_triggered_by_idx" ON "sop_executions" USING btree ("triggered_by");--> statement-breakpoint
CREATE INDEX "sop_node_exec_execution_id_idx" ON "sop_node_executions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "sop_node_exec_exec_node_idx" ON "sop_node_executions" USING btree ("execution_id","node_id");--> statement-breakpoint
CREATE INDEX "sop_node_exec_status_idx" ON "sop_node_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sop_pause_execution_id_idx" ON "sop_pause_states" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "sop_pause_exec_node_idx" ON "sop_pause_states" USING btree ("execution_id","node_id");--> statement-breakpoint
CREATE INDEX "sop_pause_status_idx" ON "sop_pause_states" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sop_pause_approval_token_idx" ON "sop_pause_states" USING btree ("approval_token");--> statement-breakpoint
CREATE INDEX "system_connections_type_idx" ON "system_connections" USING btree ("type");--> statement-breakpoint
CREATE INDEX "system_connections_status_idx" ON "system_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_executions_employee_id_idx" ON "task_executions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "task_executions_status_idx" ON "task_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_executions_employee_status_idx" ON "task_executions" USING btree ("employee_id","status");--> statement-breakpoint
CREATE INDEX "task_executions_workflow_run_id_idx" ON "task_executions" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "task_executions_started_at_idx" ON "task_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "task_executions_requires_review_idx" ON "task_executions" USING btree ("requires_review");--> statement-breakpoint
CREATE INDEX "ti_template_id_idx" ON "tool_instances" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "ti_connection_id_idx" ON "tool_instances" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ti_created_by_idx" ON "tool_instances" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "tools_category_idx" ON "tools" USING btree ("category");--> statement-breakpoint
CREATE INDEX "tools_created_by_idx" ON "tools" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "work_logs_task_id_idx" ON "work_logs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "work_logs_employee_id_idx" ON "work_logs" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "work_logs_log_type_idx" ON "work_logs" USING btree ("log_type");--> statement-breakpoint
CREATE INDEX "work_logs_task_log_type_idx" ON "work_logs" USING btree ("task_id","log_type");--> statement-breakpoint
CREATE INDEX "work_logs_created_at_idx" ON "work_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workspace_files_key_idx" ON "workspace_files" USING btree ("key");--> statement-breakpoint
CREATE INDEX "workspace_files_user_id_idx" ON "workspace_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_files_workspace_id_idx" ON "workspace_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_files_context_idx" ON "workspace_files" USING btree ("context");--> statement-breakpoint
-- ============================================================
-- Migration 0006: Tool Dev Studio (Sub-spec B) — sessions / messages / pending_actions
-- Source: packages/db/migrations/0006_tool_dev_studio_b_tables.sql
-- ============================================================
CREATE TABLE "tool_dev_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_dev_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"ask_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_dev_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"adopted_at" timestamp with time zone,
	"tool_id" text,
	"last_message_preview" text,
	"pipeline_phases" jsonb,
	"phase" text,
	"phase_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_container_id" text,
	"container_status" text DEFAULT 'destroyed' NOT NULL,
	"workspace_dir" text NOT NULL,
	"claude_state_dir" text NOT NULL,
	"right_panel_visible" boolean DEFAULT false NOT NULL,
	"approved_dependencies" jsonb DEFAULT '{"libraries":[],"domains":[]}'::jsonb NOT NULL,
	"last_package" jsonb,
	"model_config_id" text,
	"model_name" text,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_instance_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"hashed_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_dev_messages" ADD CONSTRAINT "tool_dev_messages_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_pending_actions" ADD CONSTRAINT "tool_dev_pending_actions_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD CONSTRAINT "tool_dev_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD CONSTRAINT "tool_dev_sessions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD CONSTRAINT "tool_dev_sessions_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_instance_api_keys" ADD CONSTRAINT "tool_instance_api_keys_instance_id_tool_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tiak_instance_id_idx" ON "tool_instance_api_keys" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "tiak_hashed_key_idx" ON "tool_instance_api_keys" USING btree ("hashed_key");--> statement-breakpoint
CREATE INDEX "tool_dev_messages_session_idx" ON "tool_dev_messages" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "tool_dev_pending_actions_session_idx" ON "tool_dev_pending_actions" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_dev_pending_actions_session_askid_uidx" ON "tool_dev_pending_actions" USING btree ("session_id","ask_id");--> statement-breakpoint
CREATE INDEX "tool_dev_sessions_user_idx" ON "tool_dev_sessions" USING btree ("user_id","status","last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tool_dev_sessions_user_running_uidx" ON "tool_dev_sessions" USING btree ("user_id") WHERE container_status = 'running';
-- ============================================================
-- Seed: RBAC reference data (platform_permission_defs + platform_role_permissions)
-- Source: pg_dump --data-only from the dev/prod DB.
-- Idempotent via ON CONFLICT DO NOTHING.
-- ============================================================

INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('user:list', '查看用户列表', '查看所有平台用户', 'user', 100, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('user:role_edit', '修改用户角色', '修改用户的平台角色', 'user', 110, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('user:status_edit', '启用/禁用用户', '切换用户账号的启用状态', 'user', 120, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('user:approval', '审批用户', '审批新注册用户的申请', 'user', 130, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('role:view', '查看角色权限', '查看角色权限配置', 'role', 200, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('role:edit', '编辑角色权限', '修改角色的权限分配', 'role', 210, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('registration:view', '查看注册设置', '查看注册与审批配置', 'registration', 300, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('registration:edit', '修改注册设置', '修改注册开关、审批、白名单', 'registration', 310, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('employee:list', '查看数字员工', '查看数字员工列表', 'employee', 400, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('employee:create', '创建数字员工', '新建数字员工', 'employee', 410, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('employee:edit', '编辑数字员工', '修改数字员工信息和配置', 'employee', 420, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('employee:delete', '删除数字员工', '删除数字员工', 'employee', 430, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('connector:list', '查看系统连接', '查看连接器列表', 'connector', 500, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('connector:create', '创建系统连接', '新建连接器', 'connector', 510, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('connector:edit', '编辑系统连接', '修改连接器配置', 'connector', 520, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('connector:delete', '删除系统连接', '删除连接器', 'connector', 530, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('connector:test', '测试系统连接', '测试连接器连通性', 'connector', 540, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('skill:list', '查看工具列表', '查看工具模板和实例', 'skill', 550, '2026-04-08 13:14:50.490507+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('skill:create', '创建工具', '新建工具模板和实例', 'skill', 560, '2026-04-08 13:14:50.490507+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('skill:edit', '编辑工具', '修改工具配置和代码', 'skill', 570, '2026-04-08 13:14:50.490507+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('skill:delete', '删除工具', '删除工具模板和实例', 'skill', 580, '2026-04-08 13:14:50.490507+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('skill:deploy', '部署工具', '上架/下架工具实例', 'skill', 590, '2026-04-08 13:14:50.490507+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('model:list', '查看模型列表', '查看AI模型列表', 'model', 600, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('model:create', '创建模型', '新建AI模型配置', 'model', 610, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('model:edit', '编辑模型', '修改AI模型配置', 'model', 620, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('model:delete', '删除模型', '删除AI模型', 'model', 630, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('model:test', '测试模型', '测试AI模型调用', 'model', 640, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('system:view', '查看系统信息', '查看系统版本、健康、统计', 'system', 700, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('system:health_check', '执行健康检查', '手动触发系统健康检查', 'system', 710, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('license:view', '查看许可证', '查看许可证信息', 'system', 720, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('license:upload', '上传许可证', '上传/更新许可证', 'system', 730, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('task:list', '查看任务列表', '查看任务执行记录', 'task', 800, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('task:create', '创建任务', '手动创建执行任务', 'task', 810, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('task:cancel', '取消任务', '取消正在执行的任务', 'task', 820, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('template:list', '查看模板列表', '查看工作流模板', 'template', 900, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('template:create', '创建模板', '新建工作流模板', 'template', 910, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('template:edit', '编辑模板', '修改工作流模板', 'template', 920, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('template:delete', '删除模板', '删除工作流模板', 'template', 930, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('knowledge:list', '查看知识库', '查看知识库列表', 'knowledge', 1000, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('knowledge:create', '创建知识库', '新建知识库', 'knowledge', 1010, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('knowledge:edit', '编辑知识库', '修改知识库内容', 'knowledge', 1020, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('knowledge:delete', '删除知识库', '删除知识库', 'knowledge', 1030, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('channel:list', '查看渠道列表', '查看消息渠道列表', 'channel', 1100, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('channel:create', '创建渠道', '新建消息渠道', 'channel', 1110, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('channel:edit', '编辑渠道', '修改渠道配置', 'channel', 1120, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('channel:delete', '删除渠道', '删除消息渠道', 'channel', 1130, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sop:list', '查看SOP列表', '查看SOP流程列表', 'sop', 1200, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sop:create', '创建SOP', '新建SOP流程', 'sop', 1210, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sop:edit', '编辑SOP', '修改SOP流程', 'sop', 1220, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sop:delete', '删除SOP', '删除SOP流程', 'sop', 1230, '2026-04-07 11:05:42.446482+00') ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sandbox:view', '查看沙箱设置', '查看沙箱预装库与网络白名单配置', 'sandbox', 1300, NOW()) ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_permission_defs (code, name, description, category, sort_order, created_at) VALUES ('sandbox:edit', '修改沙箱设置', '修改沙箱预装库、网络白名单与出网模式', 'sandbox', 1310, NOW()) ON CONFLICT (code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('seed-sandbox-view-super', 'super_admin', 'sandbox:view', NOW(), NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('seed-sandbox-edit-super', 'super_admin', 'sandbox:edit', NOW(), NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('seed-sandbox-view-admin', 'admin', 'sandbox:view', NOW(), NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('41a297ac7d56ffcf9412f', 'super_admin', 'user:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('8efbe6980eaaa02b63708', 'super_admin', 'user:role_edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('2485230ff00fe11548dee', 'super_admin', 'user:status_edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('23fe172d8bb3d6351c745', 'super_admin', 'user:approval', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('bd0cd5d7191650df9f154', 'super_admin', 'role:view', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('81ec258ba1a546694584c', 'super_admin', 'role:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('baa3ea80ac6709b1ed808', 'super_admin', 'registration:view', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('f70c2e9715ba0fdae92e2', 'super_admin', 'registration:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('db72fd18fd660eb452b0c', 'super_admin', 'employee:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('788519630b9b497a36272', 'super_admin', 'employee:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ce9f6981744490d608105', 'super_admin', 'employee:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('8d83d62438d5990adb229', 'super_admin', 'employee:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('0391ea273563c07e87733', 'super_admin', 'connector:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('145bdb61957f98d34c162', 'super_admin', 'connector:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('1d1472f43a26ce62c2cee', 'super_admin', 'connector:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('a072797a15fe9d0ffca0e', 'super_admin', 'connector:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('2be265588c3bd91640401', 'super_admin', 'connector:test', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('efe52036301279bc6e976', 'super_admin', 'model:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('8ae6b0ab7019a170c82b2', 'super_admin', 'model:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('31b21efa36c09a558be79', 'super_admin', 'model:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('e61da5cfee9603339221b', 'super_admin', 'model:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('69793d582aab5e5c5ea8f', 'super_admin', 'model:test', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('e7a8c382de8e77ba487d0', 'super_admin', 'system:view', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('da6bdd1d50d842d154e20', 'super_admin', 'system:health_check', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('3eec0a9be4747b5826dd6', 'super_admin', 'license:view', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('91f99922a4e4b30b94d41', 'super_admin', 'license:upload', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('220d3a192a3bdc586b8c0', 'super_admin', 'task:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('0b71ed04f2e23414ff761', 'super_admin', 'task:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('722f3c7628fe55359ff89', 'super_admin', 'task:cancel', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('b21b8c2c5d71a167bb2e7', 'super_admin', 'template:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('082a313e62e7c54d0a348', 'super_admin', 'template:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('b4c656aef9c79f5285e50', 'super_admin', 'template:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('840a5d4f64cbdc0e74e27', 'super_admin', 'template:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('0a3ab1e8b405a0fa5d310', 'super_admin', 'knowledge:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('3e40983c1b9e8de7d5606', 'super_admin', 'knowledge:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('fc9cafadb8f50ee8b701c', 'super_admin', 'knowledge:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('c0b15121bc1eb08772016', 'super_admin', 'knowledge:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ebf01cdf2328a34ba5b3b', 'super_admin', 'channel:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('49fef0683f4116e07a540', 'super_admin', 'channel:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('e8dff33d655a46d794464', 'super_admin', 'channel:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('d570ae5d6c446dee074cd', 'super_admin', 'channel:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('f7ed76aaef0d0f6a4b88b', 'super_admin', 'sop:list', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('d616b0d1a76567a40c7d3', 'super_admin', 'sop:create', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('b09b4a8ca9bfbe0cab4d6', 'super_admin', 'sop:edit', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('4890a154222f657080d78', 'super_admin', 'sop:delete', '2026-04-07 11:05:42.446482+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('2e64c2609ed98114371f7', 'super_admin', 'skill:list', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('2e9be7c0706ebd9d11621', 'super_admin', 'skill:create', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('4f84a97d9af7c49880f99', 'super_admin', 'skill:edit', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('af27f66754eb960b5bbf3', 'super_admin', 'skill:delete', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('d7471cfee3843ef9e1ab4', 'super_admin', 'skill:deploy', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('cb441925ed37a4a204c40', 'admin', 'skill:list', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('745a17586359a26207151', 'admin', 'skill:create', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('55ed24ab44022663aade0', 'admin', 'skill:edit', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('bd3c773631c0052e90cee', 'admin', 'skill:delete', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('3295bac72b6f6671266fa', 'admin', 'skill:deploy', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('53994db8897149a9147a7', 'member', 'skill:list', '2026-04-08 13:14:50.490507+00', NULL) ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('LPvVbLysDdEJfUiNzmCHx', 'admin', 'user:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('NS8q-2vtKRM0u5Uv4Rsdl', 'admin', 'role:view', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('QRxsKjdtZTk15-WcZYkdp', 'admin', 'registration:view', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('QRo28vtVixugfJzQZh_kW', 'admin', 'employee:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('y1EQ3MiXcZy5NDMh6S6zg', 'admin', 'employee:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('gVWQn6tb6dErFtXBjp4tX', 'admin', 'employee:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('PocX1GPZ1lNWERtsO-JNV', 'admin', 'employee:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('PCd4UyyU8afxDGbAqtWu6', 'admin', 'connector:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('hfY-Z-i0GYCPT7tjlYDl6', 'admin', 'connector:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('qFqYHPqfuOGo23Ed1YlaH', 'admin', 'connector:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('D6PFyr0SchwTrHYJv76kD', 'admin', 'connector:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('GC4rnmcX1-L0buo0iarWB', 'admin', 'connector:test', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('uhYmu9z_VLqFSvoPlB9kg', 'admin', 'model:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('lRNlXJJf0NsQ5SkBSRTZ9', 'admin', 'model:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('AuRECCqBcxgRp8SBdxAMH', 'admin', 'model:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('8ci4bIll_23Ff_SwWDoMh', 'admin', 'model:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('qVmz06YF3uMpu1RkWn4tu', 'admin', 'model:test', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('gohso3TZuvL9RBtjMCBtw', 'admin', 'system:view', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('SRu23jk89Nj_TAXy7x9jv', 'admin', 'license:view', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ck50tAchOdDCQto_8g74x', 'admin', 'task:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('eicrKN1rqnFnhxaGHmZgv', 'admin', 'task:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('T49Lqzddn_8yAdSHFhiOT', 'admin', 'task:cancel', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('unkPKfAhOCNcguMVK2IUp', 'admin', 'template:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('An18EcySaVuBqGTSnDrNv', 'admin', 'template:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('c5_rv5aTqO_iPh129qqQF', 'admin', 'template:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('IvMcynqR7jS-lsrUm55jt', 'admin', 'template:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ZPKnPnSvLUIhsNyChEjtO', 'admin', 'knowledge:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('nP-uazMIhDEKr6zx3LV8C', 'admin', 'knowledge:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('9Ow3j17DCVBhzpqDHiy0g', 'admin', 'knowledge:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('Xh5EeBpiu2tgw76GBogX-', 'admin', 'knowledge:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('220PCdEx1765yyfY39g_h', 'admin', 'channel:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('0km9y0-1RFbtB3eD5hULO', 'admin', 'channel:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('h-G0uE6SkS7T_bHT-GTF3', 'admin', 'channel:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('teVPaWuoSbl8DLRxrmRLs', 'admin', 'channel:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ouVHw6j3GGBIwh3ePk3Pe', 'admin', 'sop:list', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('F5k62v2XefQqob3cquLHp', 'admin', 'sop:create', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('kMBkURmcI0t1TKPmm_d8H', 'admin', 'sop:edit', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('zyIFh1sD9FLZeCYHcadwx', 'admin', 'sop:delete', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('HQbBRHVRFTWjLfxSRTDqK', 'admin', 'user:approval', '2026-04-07 15:24:27.339302+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('pQf5VqdXbmtVm3NtzUoFq', 'member', 'employee:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('X16hcAeG2ggK1ATpvG9Lo', 'member', 'connector:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('aRnDtmEwLqoN6_-jOuuXU', 'member', 'model:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('ZC6IYp82HVGAXIj5SK0UH', 'member', 'system:view', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('1yhDJTvCPS080zqTKXHPr', 'member', 'license:view', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('GV9o81Ec3KyXJRH4U7em_', 'member', 'template:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('LusyEaxr-79eJeZI75FEC', 'member', 'knowledge:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('2swWL45BuJvxicFeuXG6J', 'member', 'channel:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('Tkve20DS2rLZEK-EFb-xJ', 'member', 'sop:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;
INSERT INTO public.platform_role_permissions (id, role, permission_code, created_at, created_by) VALUES ('jLOz6DBhRY2Ab5PxG5R5F', 'member', 'task:list', '2026-04-08 11:45:59.958591+00', 'BYOo7QE4QkY2iPNkKJyiPEYqXrgATjrW') ON CONFLICT (role, permission_code) DO NOTHING;

-- ============================================================
-- Seed: 3 development accounts (admin/ops/viewer)
-- WARNING: For dev/test only. DO NOT use in production.
-- Password hashes: better-auth scrypt. Regenerate via
-- `bun run packages/db/scripts/gen-seed-hashes.ts`
-- when better-auth major versions change.
-- ============================================================

INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at, is_super_user, approval_status)
VALUES
  ('seed-user-super-admin', 'admin@crewmeld.local', 'Super Admin', true, NOW(), NOW(), true,  'approved'),
  ('seed-user-admin',       'ops@crewmeld.local',   'Ops Admin',   true, NOW(), NOW(), false, 'approved'),
  ('seed-user-member',      'viewer@crewmeld.local','Viewer',      true, NOW(), NOW(), false, 'approved')
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  name = EXCLUDED.name,
  email_verified = EXCLUDED.email_verified,
  is_super_user = EXCLUDED.is_super_user,
  approval_status = EXCLUDED.approval_status,
  updated_at = NOW();

INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
VALUES
  ('seed-acct-super-admin', 'admin@crewmeld.local', 'credential', 'seed-user-super-admin', '048130c5db7221b9aa85462d9debb811:139d13130e1024a158c286b59f5b54fdaf578ab5b90d24c676b9c7e2542a7ccda10cccadab1b5fd7ab40e7adf3370393e72c2e8b237329959b5088ff20caf422', NOW(), NOW()),
  ('seed-acct-admin',       'ops@crewmeld.local',   'credential', 'seed-user-admin',       '7117fcc99e2613f36d51dcfcdf989306:2aabf661ec00ac8760bcb547347b54fe67186772529fc22a29fd33c054b49b1d8541ec6f0ff70d277ed3351fdcae311558f380530e747b2ca9aaac89cd8f6d81', NOW(), NOW()),
  ('seed-acct-member',      'viewer@crewmeld.local','credential', 'seed-user-member',      '8c08c9c3e0934758c2c1dc3ec0ba6420:edc62d04edad943db1e48333c2c510cb7c283ec8d4ba8fdf861a63550512353d27f9b69aca7d9442de716e71ea42febc6d3241ff8f02f6738ef061747f93a84b', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  password = EXCLUDED.password,
  updated_at = NOW();

INSERT INTO employee_platform_roles (id, user_id, role, is_disabled, created_at, updated_at)
VALUES
  ('seed-epr-super-admin', 'seed-user-super-admin', 'super_admin', false, NOW(), NOW()),
  ('seed-epr-admin',       'seed-user-admin',       'admin',       false, NOW(), NOW()),
  ('seed-epr-member',      'seed-user-member',      'member',      false, NOW(), NOW())
ON CONFLICT (user_id) DO UPDATE SET
  role = EXCLUDED.role,
  is_disabled = false,
  updated_at = NOW();

-- Per-invocation tool execution record. See packages/db/schema/tool-executions.ts.
CREATE TABLE IF NOT EXISTS tool_executions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id uuid REFERENCES tool_dev_sessions(id) ON DELETE SET NULL,
  instance_id text REFERENCES tool_instances(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_executions_user_idx ON tool_executions(user_id, created_at);
CREATE INDEX IF NOT EXISTS tool_executions_session_idx ON tool_executions(session_id);
CREATE INDEX IF NOT EXISTS tool_executions_instance_idx ON tool_executions(instance_id);
