CREATE TABLE "tool_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid,
	"instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_session_id_tool_dev_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."tool_dev_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_instance_id_tool_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_executions_user_idx" ON "tool_executions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_executions_session_idx" ON "tool_executions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tool_executions_instance_idx" ON "tool_executions" USING btree ("instance_id");