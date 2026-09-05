-- Migration: 004_idempotency_hash.sql
-- Description: Add payload_hash to sync_operations for key reuse conflict detection

ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_sync_operations_payload_hash ON sync_operations(payload_hash);
