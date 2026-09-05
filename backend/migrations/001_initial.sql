-- Migration: 001_initial.sql
-- Description: Create initial schema with strict CHECK constraints

CREATE TABLE IF NOT EXISTS categories (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) PRIMARY KEY,
    category_id VARCHAR(64) REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    quantity NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    sold NUMERIC NOT NULL DEFAULT 0 CHECK (sold >= 0),
    price NUMERIC NOT NULL DEFAULT 0 CHECK (price >= 0),
    notes TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

-- Activities are append-only immutable events (never updated or deleted)
CREATE TABLE IF NOT EXISTS activities (
    id VARCHAR(64) PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    timestamp BIGINT NOT NULL,
    product_id VARCHAR(64),
    product_name VARCHAR(255),
    category_id VARCHAR(64),
    category_name VARCHAR(255),
    quantity NUMERIC,
    notes TEXT,
    previous_quantity NUMERIC,
    previous_sold NUMERIC
);

CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at BIGINT NOT NULL
);
