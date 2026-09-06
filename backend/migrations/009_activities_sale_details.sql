-- Migration: 009_activities_sale_details.sql
-- Description: Add sale_id, discount, subtotal, items_count, and items_json to activities table for audit breakdowns

ALTER TABLE activities ADD COLUMN IF NOT EXISTS sale_id VARCHAR(64);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS discount BIGINT DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS subtotal BIGINT DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS items_count INTEGER DEFAULT 1;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS items_json JSONB;

CREATE INDEX IF NOT EXISTS idx_activities_sale_id ON activities(sale_id);
