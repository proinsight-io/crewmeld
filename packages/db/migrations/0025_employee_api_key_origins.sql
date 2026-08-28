ALTER TABLE employee_api_keys
  ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb;
