CREATE TABLE IF NOT EXISTS employee_api_keys (id text PRIMARY KEY, employee_id text NOT NULL REFERENCES digital_employees(id) ON DELETE CASCADE, user_id text, allowed_support_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb, name text NOT NULL, key_prefix text NOT NULL, hashed_key text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz);
ALTER TABLE employee_api_keys ADD COLUMN IF NOT EXISTS allowed_support_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS eak_employee_id_idx ON employee_api_keys(employee_id);
CREATE INDEX IF NOT EXISTS eak_hashed_key_idx ON employee_api_keys(hashed_key);
