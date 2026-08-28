-- Reconcile databases that previously migrated on either side of the
-- dev0.0.1 and ai-customer-Service branch split. Every statement is
-- idempotent because this migration may follow either migration history.

ALTER TABLE tool_instances ADD COLUMN IF NOT EXISTS service_auth_mode text NOT NULL DEFAULT 'api-key';
ALTER TABLE tool_instances ADD COLUMN IF NOT EXISTS service_visibility text NOT NULL DEFAULT 'internal';
ALTER TABLE tool_instances ADD COLUMN IF NOT EXISTS service_domain text;
ALTER TABLE tool_instances ADD COLUMN IF NOT EXISTS desired_replicas integer NOT NULL DEFAULT 1;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS service_spec jsonb;

CREATE TABLE IF NOT EXISTS tool_service_replicas (
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES tool_instances(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  name text NOT NULL,
  sandbox_id text,
  endpoint text,
  status text NOT NULL DEFAULT 'creating',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tsr_instance_id_idx ON tool_service_replicas(instance_id);
CREATE UNIQUE INDEX IF NOT EXISTS tsr_instance_ordinal_unique_idx
  ON tool_service_replicas(instance_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS ti_service_domain_unique_idx ON tool_instances(service_domain);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id text PRIMARY KEY,
  ragflow_dataset_id text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'document',
  threshold_override double precision,
  enabled boolean NOT NULL DEFAULT true,
  navigation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_bases_type_check CHECK (type IN ('document', 'qa')),
  CONSTRAINT knowledge_bases_threshold_override_check CHECK (
    threshold_override IS NULL OR (threshold_override >= 0 AND threshold_override <= 1)
  )
);

DO $$ BEGIN
  CREATE TYPE qa_record_status AS ENUM ('pending', 'syncing', 'active', 'failed', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE qa_cleanup_status AS ENUM ('pending', 'not_required', 'complete', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS qa_csv_batches (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  active_version_id text,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qa_document_versions (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE,
  ragflow_document_id text,
  checksum text NOT NULL,
  filename text NOT NULL,
  status qa_record_status NOT NULL DEFAULT 'pending',
  cleanup_status qa_cleanup_status NOT NULL DEFAULT 'pending',
  cleanup_error text,
  parsed_at timestamptz,
  synced_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE qa_csv_batches
    ADD CONSTRAINT qa_csv_batches_active_version_fk
    FOREIGN KEY (active_version_id) REFERENCES qa_document_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS qa_questions (
  id text PRIMARY KEY,
  knowledge_base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  normalized_question text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  updated_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qa_sync_jobs (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE,
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  status qa_record_status NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qa_csv_batches_knowledge_base_idx ON qa_csv_batches(knowledge_base_id);
CREATE INDEX IF NOT EXISTS qa_document_versions_batch_status_idx ON qa_document_versions(batch_id, status);
CREATE INDEX IF NOT EXISTS qa_questions_batch_idx ON qa_questions(batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS qa_questions_enabled_normalized_uidx
  ON qa_questions(knowledge_base_id, normalized_question) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS qa_sync_jobs_batch_status_idx ON qa_sync_jobs(batch_id, status);

CREATE TABLE IF NOT EXISTS employee_api_keys (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  user_id text,
  allowed_support_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  name text NOT NULL,
  key_prefix text NOT NULL,
  hashed_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
ALTER TABLE employee_api_keys ADD COLUMN IF NOT EXISTS allowed_support_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee_api_keys ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS eak_employee_id_idx ON employee_api_keys(employee_id);
CREATE INDEX IF NOT EXISTS eak_hashed_key_idx ON employee_api_keys(hashed_key);

ALTER TABLE tool_instance_api_keys ADD COLUMN IF NOT EXISTS user_id text;
CREATE INDEX IF NOT EXISTS tiak_user_id_idx ON tool_instance_api_keys(user_id);

DO $$ BEGIN
  CREATE TYPE human_handoff_status AS ENUM ('open', 'assigned', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'human_handoffs'
      AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE human_handoffs ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE human_handoffs
      ALTER COLUMN status TYPE human_handoff_status
      USING status::human_handoff_status;
    ALTER TABLE human_handoffs
      ALTER COLUMN status SET DEFAULT 'open'::human_handoff_status;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS human_handoffs (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assignee_id text REFERENCES human_employees(id) ON DELETE SET NULL,
  status human_handoff_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE human_handoffs
  ADD COLUMN IF NOT EXISTS claimed_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS human_handoffs_conversation_idx ON human_handoffs(conversation_id);
CREATE INDEX IF NOT EXISTS human_handoffs_assignee_idx ON human_handoffs(assignee_id);
CREATE INDEX IF NOT EXISTS human_handoffs_claimed_by_user_idx ON human_handoffs(claimed_by_user_id);

CREATE TABLE IF NOT EXISTS knowledge_question_groups (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE,
  knowledge_base_id text REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  canonical_question text NOT NULL,
  normalized_question text NOT NULL,
  answer text,
  occurrence_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open',
  merged_into_id text REFERENCES knowledge_question_groups(id) ON DELETE SET NULL,
  promoted_qa_question_id text REFERENCES qa_questions(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_question_occurrences (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES knowledge_question_groups(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE,
  original_question text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_question_merge_operations (
  id text PRIMARY KEY,
  target_group_id text NOT NULL REFERENCES knowledge_question_groups(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  reverted_at timestamptz,
  reverted_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_question_groups_employee_status_idx ON knowledge_question_groups(employee_id, status);
CREATE INDEX IF NOT EXISTS knowledge_question_groups_knowledge_base_idx ON knowledge_question_groups(knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_question_groups_popularity_idx ON knowledge_question_groups(occurrence_count DESC, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_question_groups_scope_normalized_uidx
  ON knowledge_question_groups(employee_id, COALESCE(knowledge_base_id, '__other__'), normalized_question)
  WHERE status <> 'merged';
CREATE INDEX IF NOT EXISTS knowledge_question_occurrences_group_idx ON knowledge_question_occurrences(group_id);
CREATE INDEX IF NOT EXISTS knowledge_question_occurrences_created_at_idx ON knowledge_question_occurrences(created_at);
CREATE INDEX IF NOT EXISTS knowledge_question_merge_operations_target_idx ON knowledge_question_merge_operations(target_group_id);

CREATE TABLE IF NOT EXISTS knowledge_unanswered_questions (
  id text PRIMARY KEY,
  question_group_id text NOT NULL UNIQUE REFERENCES knowledge_question_groups(id) ON DELETE CASCADE,
  knowledge_base_id text REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  question text NOT NULL,
  normalized_question text NOT NULL,
  conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
  max_similarity double precision,
  reason text NOT NULL CONSTRAINT knowledge_unanswered_questions_reason_check CHECK (reason IN ('no_chunks', 'low_similarity', 'model_declined')),
  status text NOT NULL DEFAULT 'pending' CONSTRAINT knowledge_unanswered_questions_status_check CHECK (status IN ('pending', 'syncing', 'resolved', 'ignored', 'sync_failed')),
  occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_qa_question_id text REFERENCES qa_questions(id) ON DELETE SET NULL,
  sync_error text,
  resolved_at timestamptz,
  resolved_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_status_idx ON knowledge_unanswered_questions(status);
CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_knowledge_base_idx ON knowledge_unanswered_questions(knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_occurrence_count_idx
  ON knowledge_unanswered_questions(occurrence_count DESC, last_seen_at DESC);

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

CREATE TABLE IF NOT EXISTS knowledge_document_images (
  id text PRIMARY KEY,
  dataset_id text NOT NULL,
  document_id text NOT NULL,
  anchor_text text NOT NULL,
  mime_type text NOT NULL,
  content_base64 text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_document_images
  ADD COLUMN IF NOT EXISTS source_char_offset integer,
  ADD COLUMN IF NOT EXISTS source_text text,
  ADD COLUMN IF NOT EXISTS bound_chunk_id text,
  ADD COLUMN IF NOT EXISTS binding_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS binding_error text,
  ADD COLUMN IF NOT EXISTS binding_generation integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS knowledge_document_images_document_idx ON knowledge_document_images(document_id);
CREATE INDEX IF NOT EXISTS knowledge_document_images_dataset_idx ON knowledge_document_images(dataset_id);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_images_document_order_unique
  ON knowledge_document_images(document_id, sort_order);
CREATE INDEX IF NOT EXISTS knowledge_document_images_bound_chunk_idx
  ON knowledge_document_images(bound_chunk_id) WHERE bound_chunk_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_document_images_pending_idx
  ON knowledge_document_images(binding_status, document_id);
