-- Migration: 007_product_translations.sql
-- Description: Add multilingual translations JSONB column to products with GIN index

-- 1. Add translations column (stores { "uz": "...", "ru": "...", "en": "...", "hasTypo": boolean, "corrected": "..." })
ALTER TABLE products ADD COLUMN IF NOT EXISTS translations JSONB DEFAULT '{}'::jsonb;

-- 2. Create GIN index for fast JSON searches across multilingual names
CREATE INDEX IF NOT EXISTS idx_products_translations ON products USING GIN (translations);
