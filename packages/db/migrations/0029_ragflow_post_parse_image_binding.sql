ALTER TABLE knowledge_document_images
  ADD COLUMN IF NOT EXISTS source_char_offset integer,
  ADD COLUMN IF NOT EXISTS source_text text,
  ADD COLUMN IF NOT EXISTS bound_chunk_id text,
  ADD COLUMN IF NOT EXISTS binding_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS binding_error text,
  ADD COLUMN IF NOT EXISTS binding_generation integer NOT NULL DEFAULT 1;

UPDATE knowledge_document_images
SET binding_status = 'pending',
    bound_chunk_id = NULL,
    binding_error = NULL;

CREATE INDEX IF NOT EXISTS knowledge_document_images_bound_chunk_idx
  ON knowledge_document_images(bound_chunk_id)
  WHERE bound_chunk_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_document_images_pending_idx
  ON knowledge_document_images(binding_status, document_id);
