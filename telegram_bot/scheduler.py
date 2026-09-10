"""
Bazar Telegram Bot — Nightly Report Push Scheduler (Python)

CORE RULES:
- Timezone: Fixed to Asia/Tashkent (UTC+05:00). Default time: 21:00.
- Atomic Race Safety: Uses telegram_report_dispatches table in PostgreSQL with
  unique (report_date, chat_id) and atomic claiming before generation.
- Transient failure recovery: If sending fails, status is marked FAILED so retry can occur,
  while successful SENT records prevent duplicate dispatches on restarts.
- Recipient isolation: Dispatches exclusively to TELEGRAM_REPORT_CHAT_IDS.
"""

import logging
import time
from typing import Optional
import zoneinfo
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiogram import Bot
from aiogram.types import BufferedInputFile

from .db import get_pool
from .config import (
    TELEGRAM_DAILY_REPORT_ENABLED,
    TELEGRAM_DAILY_REPORT_TIME,
    TELEGRAM_REPORT_CHAT_IDS,
    TIMEZONE
)
from . import report_service, report_exporter
from .handlers.reports import format_single_day_text

logger = logging.getLogger(__name__)

_scheduler: Optional[AsyncIOScheduler] = None


async def claim_dispatch_lock(report_date: str, chat_id: str) -> Optional[int]:
    """
    Atomically claim dispatch lock for a given report date and chat ID.
    Returns record ID if successfully claimed, or None if already claimed/sent.
    """
    pool = get_pool()
    if pool is None:
        return None

    now = int(time.time() * 1000)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow("""
                INSERT INTO telegram_report_dispatches (report_date, chat_id, status, claimed_at)
                VALUES ($1, $2, 'CLAIMED', $3)
                ON CONFLICT (report_date, chat_id) DO UPDATE
                  SET status = 'CLAIMED', claimed_at = $3, error_message = NULL
                  WHERE telegram_report_dispatches.status = 'FAILED'
                RETURNING id
            """, report_date, str(chat_id), now)
            return row["id"] if row else None
    except Exception as err:
        logger.error(f"[scheduler] Failed to check dispatch lock for {chat_id}: {err}")
        return None


async def mark_dispatch_sent(dispatch_id: int):
    """Mark dispatch as successfully sent."""
    pool = get_pool()
    if pool is None:
        return
    try:
        now = int(time.time() * 1000)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE telegram_report_dispatches SET status = 'SENT', sent_at = $1 WHERE id = $2",
                now, dispatch_id
            )
    except Exception as err:
        logger.error(f"[scheduler] Failed to mark dispatch {dispatch_id} as SENT: {err}")


async def mark_dispatch_failed(dispatch_id: int, error_message: str):
    """Mark dispatch as failed for retry visibility."""
    pool = get_pool()
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE telegram_report_dispatches SET status = 'FAILED', error_message = $1 WHERE id = $2",
                str(error_message), dispatch_id
            )
    except Exception as err:
        logger.error(f"[scheduler] Failed to mark dispatch {dispatch_id} as FAILED: {err}")


async def execute_daily_report_push(bot: Bot, forced_date: Optional[str] = None):
    """Execute automated daily report push to all configured recipients."""
    if not bot:
        logger.warning("[scheduler] Cannot execute daily push: bot instance is None.")
        return

    date_str = forced_date or report_service.get_tashkent_today()
    recipients = TELEGRAM_REPORT_CHAT_IDS

    if not recipients:
        logger.info("[scheduler] No recipients configured in TELEGRAM_REPORT_CHAT_IDS. Skipping nightly push.")
        return

    logger.info(f"[scheduler] Starting daily report push for date: {date_str} ({len(recipients)} recipients)...")

    report_data = None
    png_bytes = None
    excel_bytes = None

    for chat_id in recipients:
        # 1. Atomic claim check
        dispatch_id = await claim_dispatch_lock(date_str, str(chat_id))
        if not dispatch_id:
            logger.info(f"[scheduler] Chat {chat_id} has already claimed/received report for {date_str}. Skipping duplicate.")
            continue

        try:
            # 2. Lazy generate data and buffers once
            if report_data is None:
                report_data = await report_service.get_report_for_date(date_str)
            if png_bytes is None:
                png_bytes = report_exporter.generate_png_report(report_data)
            if excel_bytes is None:
                excel_bytes = report_exporter.generate_excel_report(report_data)

            # 3. Send summary text
            summary_text = format_single_day_text(report_data, "Avtomatik Kunlik Hisobot")
            await bot.send_message(chat_id=chat_id, text=summary_text, parse_mode="Markdown")

            # 4. Send PNG photo
            photo_file = BufferedInputFile(png_bytes, filename=f"Bazar_Hisobot_{date_str}.png")
            await bot.send_photo(
                chat_id=chat_id,
                photo=photo_file,
                caption=f"📸 *Bazar — Kunlik hisobot rasm*\n📅 Sana: `{date_str}`",
                parse_mode="Markdown"
            )

            # 5. Send Excel workbook
            excel_file = BufferedInputFile(excel_bytes, filename=f"Bazar_Hisobot_{date_str}.xlsx")
            await bot.send_document(
                chat_id=chat_id,
                document=excel_file,
                caption=f"📑 *Bazar — Kunlik to'liq hisobot (.xlsx)*\n📅 Sana: `{date_str}`",
                parse_mode="Markdown"
            )

            # 6. Mark success
            await mark_dispatch_sent(dispatch_id)
            logger.info(f"[scheduler] Successfully sent daily report for {date_str} to chat: {chat_id}")
        except Exception as err:
            logger.error(f"[scheduler] Failed to send report to chat {chat_id}: {err}", exc_info=True)
            await mark_dispatch_failed(dispatch_id, str(err))


def start_scheduler(bot: Bot) -> Optional[AsyncIOScheduler]:
    """Start APScheduler for nightly report push."""
    global _scheduler
    if not TELEGRAM_DAILY_REPORT_ENABLED:
        logger.info("[scheduler] Nightly report push is disabled (TELEGRAM_DAILY_REPORT_ENABLED=false).")
        return None

    tz = zoneinfo.ZoneInfo(TIMEZONE)
    time_str = TELEGRAM_DAILY_REPORT_TIME.strip()
    try:
        hour, minute = map(int, time_str.split(":"))
    except Exception:
        hour, minute = 21, 0

    if _scheduler is None:
        _scheduler = AsyncIOScheduler(timezone=tz)

    _scheduler.add_job(
        execute_daily_report_push,
        trigger="cron",
        hour=hour,
        minute=minute,
        args=[bot],
        name="nightly_report_push",
        replace_existing=True
    )

    if not _scheduler.running:
        _scheduler.start()
        logger.info(f"[scheduler] APScheduler started. Nightly push scheduled at {hour:02d}:{minute:02d} ({TIMEZONE}).")

    return _scheduler


def stop_scheduler():
    """Stop APScheduler gracefully."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("[scheduler] APScheduler stopped.")
