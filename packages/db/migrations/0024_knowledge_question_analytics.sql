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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS knowledge_question_occurrences (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES knowledge_question_groups(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE,
  original_question text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS knowledge_question_merge_operations (
  id text PRIMARY KEY,
  target_group_id text NOT NULL REFERENCES knowledge_question_groups(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  reverted_at timestamptz,
  reverted_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_groups_employee_status_idx ON knowledge_question_groups(employee_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_groups_knowledge_base_idx ON knowledge_question_groups(knowledge_base_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_groups_popularity_idx ON knowledge_question_groups(occurrence_count DESC, last_seen_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_question_groups_scope_normalized_uidx
  ON knowledge_question_groups(employee_id, COALESCE(knowledge_base_id, '__other__'), normalized_question)
  WHERE status <> 'merged';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_occurrences_group_idx ON knowledge_question_occurrences(group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_occurrences_created_at_idx ON knowledge_question_occurrences(created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_question_merge_operations_target_idx ON knowledge_question_merge_operations(target_group_id);
