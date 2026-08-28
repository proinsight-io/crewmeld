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
	"pipeline_phases" jsonb,
	"phase" text,
	"phase_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_container_id" text,
	"container_status" text DEFAULT 'destroyed' NOT NULL,
	"workspace_dir" text NOT NULL,
	"claude_state_dir" text NOT NULL,
	"right_panel_visible" boolean DEFAULT false NOT NULL,
	"approved_dependencies" jsonb DEFAULT '{"libraries":[],"domains":[]}'::jsonb NOT NULL,
	"model_name" text,
	"total_input_tokens" bigint DEFAULT 0 NOT NULL,
	"total_output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_dev_messages" ADD CONSTRAINT "tool_dev_messages_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_pending_actions" ADD CONSTRAINT "tool_dev_pending_actions_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD CONSTRAINT "tool_dev_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_dev_messages_session_idx" ON "tool_dev_messages" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "tool_dev_pending_actions_session_idx" ON "tool_dev_pending_actions" USING btree ("session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_dev_pending_actions_session_askid_uidx" ON "tool_dev_pending_actions" USING btree ("session_id","ask_id");--> statement-breakpoint
CREATE INDEX "tool_dev_sessions_user_idx" ON "tool_dev_sessions" USING btree ("user_id","status","last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tool_dev_sessions_user_running_uidx" ON "tool_dev_sessions" USING btree ("user_id") WHERE container_status = 'running';