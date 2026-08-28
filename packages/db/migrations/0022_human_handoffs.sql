DO $$ BEGIN
  CREATE TYPE human_handoff_status AS ENUM ('open', 'assigned', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS human_handoffs (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assignee_id text REFERENCES human_employees(id) ON DELETE SET NULL,
  status human_handoff_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS human_handoffs_conversation_idx ON human_handoffs(conversation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS human_handoffs_assignee_idx ON human_handoffs(assignee_id);
