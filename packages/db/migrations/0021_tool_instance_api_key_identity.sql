ALTER TABLE "tool_instance_api_keys" ADD COLUMN IF NOT EXISTS "user_id" text;
CREATE INDEX IF NOT EXISTS "tiak_user_id_idx" ON "tool_instance_api_keys" USING btree ("user_id");
