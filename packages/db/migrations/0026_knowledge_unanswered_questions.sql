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

CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_status_idx
  ON knowledge_unanswered_questions(status);
CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_knowledge_base_idx
  ON knowledge_unanswered_questions(knowledge_base_id);
CREATE INDEX IF NOT EXISTS knowledge_unanswered_questions_occurrence_count_idx
  ON knowledge_unanswered_questions(occurrence_count DESC, last_seen_at DESC);
