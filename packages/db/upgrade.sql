-- ============================================================
-- CrewMeld — Catering schema upgrade script
-- Purpose: add catering/scheduling/ontology/tool tables that exist
-- in packages/db/schema/*.ts but were missing from earlier init.sql.
--
-- Idempotency: safe to re-run on an already-upgraded database.
-- Run as a DB superuser or owner of the crewmeld DB, e.g.:
--   psql "postgresql://user:pass@host:port/dbname" -f packages/db/upgrade.sql
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1. Missing enum types
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'rule_tier'
  ) THEN
    CREATE TYPE "public"."rule_tier" AS ENUM('legal', 'operational', 'soft');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'constraint_type'
  ) THEN
    CREATE TYPE "public"."constraint_type" AS ENUM('hard', 'soft');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'ontology_op_kind'
  ) THEN
    CREATE TYPE "public"."ontology_op_kind" AS ENUM('query', 'aggregate', 'schema', 'write', 'create', 'delete');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'ontology_op_source'
  ) THEN
    CREATE TYPE "public"."ontology_op_source" AS ENUM('conversation', 'sop', 'mcp');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'tool_gen_session_status'
  ) THEN
    CREATE TYPE "public"."tool_gen_session_status" AS ENUM('running', 'stopped', 'done', 'error');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Catering / scheduling / ontology / tool tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "catering_stores" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"brand" text,
	"region" text,
	"is_open" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "catering_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sop_execution_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"schedule_data" jsonb DEFAULT '[]' NOT NULL,
	"rule_hits" jsonb DEFAULT '[]' NOT NULL,
	"warnings" jsonb DEFAULT '[]' NOT NULL,
	"score" real,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "catering_store_managers" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"human_employee_id" text NOT NULL,
	"role" text DEFAULT 'store_manager' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "catering_schedule_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"changed_by" text NOT NULL,
	"change_type" text NOT NULL,
	"reason" text,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "scheduling_rule_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"default_params" jsonb DEFAULT '{}' NOT NULL,
	"params_schema" jsonb DEFAULT '{}' NOT NULL,
	"tier" "rule_tier" NOT NULL,
	"constraint_type" "constraint_type" NOT NULL,
	"category" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"implementation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "scheduling_rule_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"store_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ontology_op_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text,
	"sop_execution_id" text,
	"sop_node_id" text,
	"source" "ontology_op_source" NOT NULL,
	"op" "ontology_op_kind" NOT NULL,
	"ontology_type" text,
	"record_id" text,
	"input" jsonb DEFAULT '{}' NOT NULL,
	"output" jsonb,
	"success" boolean NOT NULL,
	"executor" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"world" text,
	"channel" text,
	"user_input" text,
	"conversation_id" text
);

CREATE TABLE IF NOT EXISTS "sop_definitions_backup" (
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"visibility_rules" jsonb
);

CREATE TABLE IF NOT EXISTS "tool_generation_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" "tool_gen_session_status" DEFAULT 'running' NOT NULL,
	"stop_reason" text,
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"current_tool" jsonb,
	"fix_count" integer DEFAULT 0 NOT NULL,
	"regen_count" integer DEFAULT 0 NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"model_id" text,
	"selected_conn_ids" jsonb DEFAULT '[]' NOT NULL,
	"phase" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tool_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid,
	"instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. Foreign keys (idempotent via DO blocks)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catering_schedules_store_id_catering_stores_id_fk') THEN
    ALTER TABLE "catering_schedules" ADD CONSTRAINT "catering_schedules_store_id_catering_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."catering_stores"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catering_store_managers_human_employee_id_human_employees_id_fk') THEN
    ALTER TABLE "catering_store_managers" ADD CONSTRAINT "catering_store_managers_human_employee_id_human_employees_id_fk" FOREIGN KEY ("human_employee_id") REFERENCES "public"."human_employees"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catering_store_managers_store_id_catering_stores_id_fk') THEN
    ALTER TABLE "catering_store_managers" ADD CONSTRAINT "catering_store_managers_store_id_catering_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."catering_stores"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catering_schedule_changes_schedule_id_catering_schedules_id_fk') THEN
    ALTER TABLE "catering_schedule_changes" ADD CONSTRAINT "catering_schedule_changes_schedule_id_catering_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."catering_schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_rule_configs_rule_id_scheduling_rule_templates_id_fk') THEN
    ALTER TABLE "scheduling_rule_configs" ADD CONSTRAINT "scheduling_rule_configs_rule_id_scheduling_rule_templates_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."scheduling_rule_templates"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ontology_op_logs_sop_execution_id_sop_executions_id_fk') THEN
    ALTER TABLE "ontology_op_logs" ADD CONSTRAINT "ontology_op_logs_sop_execution_id_sop_executions_id_fk" FOREIGN KEY ("sop_execution_id") REFERENCES "public"."sop_executions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_executions_instance_id_tool_instances_id_fk') THEN
    ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_instance_id_tool_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_executions_session_id_tool_dev_sessions_id_fk') THEN
    ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_executions_user_id_user_id_fk') THEN
    ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "catering_stores_external_id_unique" ON "catering_stores" USING btree ("external_id");
CREATE INDEX IF NOT EXISTS "catering_stores_is_open_idx" ON "catering_stores" USING btree ("is_open");
CREATE INDEX IF NOT EXISTS "catering_sched_store_period_idx" ON "catering_schedules" USING btree ("store_id", "period");
CREATE INDEX IF NOT EXISTS "catering_sched_status_idx" ON "catering_schedules" USING btree ("status");
CREATE INDEX IF NOT EXISTS "catering_sched_sop_exec_idx" ON "catering_schedules" USING btree ("sop_execution_id");
CREATE INDEX IF NOT EXISTS "catering_sched_created_at_idx" ON "catering_schedules" USING btree ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "catering_store_managers_store_emp_unique" ON "catering_store_managers" USING btree ("store_id", "human_employee_id");
CREATE INDEX IF NOT EXISTS "catering_store_managers_store_idx" ON "catering_store_managers" USING btree ("store_id");
CREATE INDEX IF NOT EXISTS "catering_store_managers_emp_idx" ON "catering_store_managers" USING btree ("human_employee_id");
CREATE INDEX IF NOT EXISTS "catering_sched_chg_sched_idx" ON "catering_schedule_changes" USING btree ("schedule_id");
CREATE INDEX IF NOT EXISTS "catering_sched_chg_created_idx" ON "catering_schedule_changes" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "sched_rule_tmpl_tier_idx" ON "scheduling_rule_templates" USING btree ("tier");
CREATE INDEX IF NOT EXISTS "sched_rule_tmpl_category_idx" ON "scheduling_rule_templates" USING btree ("category");
CREATE INDEX IF NOT EXISTS "sched_rule_cfg_rule_idx" ON "scheduling_rule_configs" USING btree ("rule_id");
CREATE INDEX IF NOT EXISTS "sched_rule_cfg_store_idx" ON "scheduling_rule_configs" USING btree ("store_id");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_employee_idx" ON "ontology_op_logs" USING btree ("employee_id", "created_at");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_sop_exec_idx" ON "ontology_op_logs" USING btree ("sop_execution_id");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_created_idx" ON "ontology_op_logs" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_world_idx" ON "ontology_op_logs" USING btree ("world", "created_at");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_channel_idx" ON "ontology_op_logs" USING btree ("channel", "created_at");
CREATE INDEX IF NOT EXISTS "ontology_op_logs_conversation_idx" ON "ontology_op_logs" USING btree ("conversation_id");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_name_idx" ON "sop_definitions_backup" USING btree ("name");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_trigger_type_idx" ON "sop_definitions_backup" USING btree ("trigger_type");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_is_active_idx" ON "sop_definitions_backup" USING btree ("is_active");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_is_public_idx" ON "sop_definitions_backup" USING btree ("is_public");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_created_by_idx" ON "sop_definitions_backup" USING btree ("created_by");
CREATE INDEX IF NOT EXISTS "sop_definitions_backup_created_at_idx" ON "sop_definitions_backup" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "tool_gen_sessions_user_status_idx" ON "tool_generation_sessions" USING btree ("user_id", "status");
CREATE INDEX IF NOT EXISTS "tool_gen_sessions_updated_at_idx" ON "tool_generation_sessions" USING btree ("updated_at");
CREATE INDEX IF NOT EXISTS "tool_executions_user_idx" ON "tool_executions" USING btree ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "tool_executions_session_idx" ON "tool_executions" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "tool_executions_instance_idx" ON "tool_executions" USING btree ("instance_id");
