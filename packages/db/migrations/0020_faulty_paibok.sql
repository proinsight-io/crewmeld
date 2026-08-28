CREATE TABLE "tool_service_replicas" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"sandbox_id" text,
	"endpoint" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_instances" ADD COLUMN "service_auth_mode" text DEFAULT 'api-key' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD COLUMN "service_visibility" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD COLUMN "service_domain" text;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD COLUMN "desired_replicas" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "service_spec" jsonb;--> statement-breakpoint
ALTER TABLE "tool_service_replicas" ADD CONSTRAINT "tool_service_replicas_instance_id_tool_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tsr_instance_id_idx" ON "tool_service_replicas" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tsr_instance_ordinal_unique_idx" ON "tool_service_replicas" USING btree ("instance_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ti_service_domain_unique_idx" ON "tool_instances" USING btree ("service_domain");