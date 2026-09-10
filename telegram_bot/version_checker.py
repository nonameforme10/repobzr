"""
Bazar Telegram Bot — Automated Version & Force Update Dispatcher
Watches version.txt, detects version changes (e.g. v1.1 -> v1.2),
and automatically pushes force-update notifications with the refreshed
ReplyKeyboardMarkup to all admins without requiring manual /start.
"""

import json
import logging
import time
from pathlib import Path
from typing import Optional
from aiogram import Bot

from .config import (
    TELEGRAM_ADMIN_IDS,
    TELEGRAM_REPORT_CHAT_IDS,
    BASE_DIR,
    ROOT_DIR
)
from .db import get_pool
from .keyboards import main_reply_keyboard

logger = logging.getLogger(__name__)


def get_version_file_path() -> Optional[Path]:
    """Find version.txt in telegram_bot/ or repository root."""
    paths = [
        BASE_DIR / "version.txt",
        ROOT_DIR / "version.txt",
        ROOT_DIR / "backend" / "version.txt"
    ]
    for p in paths:
        if p.is_file():
            return p
    return None


def read_version_info() -> Optional[str]:
    """Read and strip content of version.txt."""
    path = get_version_file_path()
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return content if content else None
    except Exception as e:
        logger.error(f"[version] Failed reading {path}: {e}")
        return None


async def get_last_broadcasted_version() -> Optional[str]:
    """Query PostgreSQL settings table for the last broadcasted version."""
    pool = get_pool()
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM settings WHERE key = 'bot_broadcasted_version'"
            )
            if row and row["value"]:
                val = row["value"]
                if isinstance(val, str):
                    try:
                        val = json.loads(val)
                    except Exception:
                        return val
                if isinstance(val, dict):
                    return val.get("version")
                return str(val)
            return None
    except Exception as e:
        logger.error(f"[version] Error reading last broadcasted version: {e}")
        return None


async def save_broadcasted_version(version_str: str):
    """Persist broadcasted version in PostgreSQL settings table."""
    pool = get_pool()
    if pool is None:
        return
    try:
        now = int(time.time() * 1000)
        payload = json.dumps({"version": version_str, "updated_at": now})
        async with pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO settings (key, value, updated_at)
                VALUES ('bot_broadcasted_version', $1::jsonb, $2)
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = $2
            """, payload, now)
    except Exception as e:
        logger.error(f"[version] Error saving broadcasted version: {e}")


async def check_and_broadcast_version_update(bot: Bot, force: bool = False):
    """
    Check if version.txt has changed. If so, broadcast update message
    with persistent ReplyKeyboardMarkup to all admins.
    """
    if not bot:
        return

    current_content = read_version_info()
    if not current_content:
        return

    last_version = await get_last_broadcasted_version()
    if not force and last_version == current_content:
        return

    logger.info(
        f"[version] New version detected: '{current_content}' (previous: '{last_version}'). "
        f"Broadcasting force-update..."
    )

    # Collect unique recipient chat IDs
    recipients = list(TELEGRAM_ADMIN_IDS)
    for r in TELEGRAM_REPORT_CHAT_IDS:
        if r not in recipients:
            recipients.append(r)

    if not recipients:
        logger.warning("[version] No recipients found in TELEGRAM_ADMIN_IDS to send update.")
        return

    update_text = (
        f"🚀 *YANGILANISH (FORCE UPDATE)*\n\n"
        f"📢 *Versiya:* `{current_content}`\n\n"
        f"✨ Bot yangilandi va barcha imkoniyatlar tayyor holatga keltirildi.\n"
        f"*/start* buyrug'ini qayta yuborishingiz shart emas — quyidagi yangilangan menyudan foydalanishingiz mumkin:\n"
    )

    success_count = 0
    for chat_id in recipients:
        try:
            await bot.send_message(
                chat_id=chat_id,
                text=update_text,
                parse_mode="Markdown",
                reply_markup=main_reply_keyboard
            )
            success_count += 1
            logger.info(f"[version] Sent version update to chat {chat_id}")
        except Exception as e:
            logger.error(f"[version] Failed sending update to {chat_id}: {e}")

    if success_count > 0:
        await save_broadcasted_version(current_content)
        logger.info(
            f"[version] Version '{current_content}' successfully broadcasted to {success_count} chats."
        )
