"""
Bazar Telegram Bot — Async Database Connection Pool (asyncpg)
"""

import logging
from typing import Optional
import asyncpg
from .config import DATABASE_URL

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


async def init_db_pool() -> Optional[asyncpg.Pool]:
    """Initialize asyncpg connection pool and ensure ledger table exists."""
    global _pool
    if _pool is not None:
        return _pool

    try:
        # Convert postgres:// to postgresql:// if needed for asyncpg
        conn_url = DATABASE_URL
        if conn_url.startswith("postgres://"):
            conn_url = "postgresql://" + conn_url[len("postgres://"):]

        _pool = await asyncpg.create_pool(
            dsn=conn_url,
            min_size=2,
            max_size=10,
            command_timeout=15.0
        )
        logger.info("[db] PostgreSQL connection pool initialized successfully.")

        # Ensure telegram_report_dispatches table exists
        async with _pool.acquire() as conn:
            await conn.execute("""
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
            """)

        return _pool
    except Exception as err:
        logger.warning(f"[db] PostgreSQL pool initialization failed: {err}")
        return None


async def close_db_pool():
    """Close asyncpg connection pool gracefully."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("[db] PostgreSQL connection pool closed.")


def get_pool() -> Optional[asyncpg.Pool]:
    """Get active connection pool."""
    return _pool


async def is_healthy() -> bool:
    """Verify database connection health."""
    if _pool is None:
        return False
    try:
        async with _pool.acquire() as conn:
            val = await conn.fetchval("SELECT 1")
            return val == 1
    except Exception:
        return False
