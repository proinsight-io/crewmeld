-- Add local RAGFlow dataset metadata and QA source-of-truth tables.
-- All objects are guarded so this migration is safe when init.sql was used first.

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
