-- Migration: 006_product_image_and_optional_quantity.sql
-- Description: Add image reference column, make quantity nullable for untracked inventory, and update constraints

-- 1. Add image reference column (stores remote ImageKit CDN URL or fallback Data URL)
ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT;

-- 2. Make quantity nullable to support untracked inventory (quantity = null)
ALTER TABLE products ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE products ALTER COLUMN quantity SET DEFAULT NULL;

-- 3. Update quantity check constraint to allow NULL while requiring >= 0 when tracked
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_quantity_check;
ALTER TABLE products ADD CONSTRAINT products_quantity_check CHECK (quantity IS NULL OR quantity >= 0);

-- 4. Update price check constraint
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_check;
ALTER TABLE products ADD CONSTRAINT products_price_check CHECK (price IS NULL OR price > 0);
