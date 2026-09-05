-- Migration: 003_sync_and_changes.sql
-- Description: Idempotent sync tracking with deterministic result caching and incremental changelog

CREATE TABLE IF NOT EXISTS sync_operations (
    id VARCHAR(128) PRIMARY KEY,
    device_id VARCHAR(128) NOT NULL,
    type VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    processed_at BIGINT NOT NULL,
    result JSONB
);

CREATE TABLE IF NOT EXISTS changes (
    seq BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(32) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL,
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_operations_device ON sync_operations(device_id);
CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes(entity_type, entity_id);
