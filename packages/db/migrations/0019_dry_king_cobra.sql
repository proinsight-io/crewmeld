ALTER TABLE "tool_dev_sessions" ADD COLUMN "coder_type" text DEFAULT 'claudecode' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD COLUMN "opencode_session_id" text;