ALTER TABLE "tools" ADD COLUMN "kind" text DEFAULT 'script' NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "api_spec" jsonb;