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
ALTER TABLE "tool_dev_sessions" ADD COLUMN "tool_id" text;--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD COLUMN "last_message_preview" text;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD COLUMN "published_as_api" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "package_key" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "package_sha256" text;--> statement-breakpoint
ALTER TABLE "tool_instance_api_keys" ADD CONSTRAINT "tool_instance_api_keys_instance_id_tool_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tiak_instance_id_idx" ON "tool_instance_api_keys" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "tiak_hashed_key_idx" ON "tool_instance_api_keys" USING btree ("hashed_key");--> statement-breakpoint
ALTER TABLE "tool_dev_sessions" ADD CONSTRAINT "tool_dev_sessions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE set null ON UPDATE no action;