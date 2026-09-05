-- Migration: 002_indexes.sql
-- Description: Add performance indexes for foreign keys and timestamp queries

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp);
CREATE INDEX IF NOT EXISTS idx_activities_product ON activities(product_id);
