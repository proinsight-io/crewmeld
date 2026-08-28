CREATE TABLE IF NOT EXISTS knowledge_document_images (
  id text PRIMARY KEY,
  dataset_id text NOT NULL,
  document_id text NOT NULL,
  anchor_text text NOT NULL,
  mime_type text NOT NULL,
  content_base64 text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_document_images_document_idx
  ON knowledge_document_images(document_id);
CREATE INDEX IF NOT EXISTS knowledge_document_images_dataset_idx
  ON knowledge_document_images(dataset_id);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_images_document_order_unique
  ON knowledge_document_images(document_id, sort_order);
