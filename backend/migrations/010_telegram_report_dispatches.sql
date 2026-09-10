-- Migration: 010_telegram_report_dispatches.sql
-- Description: Dedicated ledger for scheduled Telegram report dispatches with atomic claiming and retry visibility

CREATE TABLE IF NOT EXISTS telegram_report_dispatches (
    id BIGSERIAL PRIMARY KEY,
    report_date VARCHAR(10) NOT NULL,
    chat_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'CLAIMED',
    claimed_at BIGINT NOT NULL,
    sent_at BIGINT,
    error_message TEXT,
    CONSTRAINT uq_report_dispatch UNIQUE (report_date, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_dispatches_date ON telegram_report_dispatches(report_date);
CREATE INDEX IF NOT EXISTS idx_telegram_dispatches_status ON telegram_report_dispatches(status);
