CREATE TABLE "channel_field_mappings" (
	"field_key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"target" text DEFAULT 'scope' NOT NULL,
	"value_type" text DEFAULT 'string' NOT NULL,
	"paths" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
