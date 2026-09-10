"""
Bazar Telegram Bot — Date Selection & Custom Date Handlers (aiogram 3)
"""

import logging
import re
import time
from aiogram import Router, F
from aiogram.filters import Command
from aiogram.types import Message
from .. import report_service
from .reports import format_single_day_text
from ..keyboards import report_inline_keyboard, main_reply_keyboard, cancel_reply_keyboard

logger = logging.getLogger(__name__)
router = Router(name="dates")

# In-memory map of user_id -> timestamp (waiting for date input)
_waiting_users = {}


@router.message(F.text == "📅 Boshqa sana")
async def handle_ask_date(message: Message):
    if message.from_user:
        _waiting_users[message.from_user.id] = time.time()

    text = (
        "📅 *Qaysi sanaga hisobot kerak?*\n\n"
        "Sanani quyidagi formatda yuboring:\n"
        "`YYYY-MM-DD`\n\n"
        "*Masalan:*\n"
        "`2026-09-08`"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=cancel_reply_keyboard)


@router.message(F.text == "❌ Bekor qilish")
async def handle_cancel_date(message: Message):
    if message.from_user:
        _waiting_users.pop(message.from_user.id, None)

    await message.reply("Amal bekor qilindi.", reply_markup=main_reply_keyboard)


async def process_date_input(message: Message, raw_text: str):
    date_str = raw_text.strip()
    user_id = message.from_user.id if message.from_user else None

    # 1. Validation: Format & Calendar existence
    if not report_service.is_valid_date_string(date_str):
        await message.reply(
            "❌ *Sana noto'g'ri ko'rsatilgan!*\n\n"
            "Iltimos, mavjud kalendar sanasini `YYYY-MM-DD` formatida qayta yuboring.\n"
            "Masalan: `2026-09-08`",
            parse_mode="Markdown",
            reply_markup=cancel_reply_keyboard
        )
        return

    # 2. Validation: Future date rejection
    today_str = report_service.get_tashkent_today()
    if date_str > today_str:
        await message.reply(
            f"❌ *Kelajakdagi sana uchun hisobot mavjud emas!*\n\n"
            f"Bugungi sana: `{today_str}`\n"
            f"Iltimos, bugun yoki undan oldingi sanani kiriting.",
            parse_mode="Markdown",
            reply_markup=cancel_reply_keyboard
        )
        return

    if user_id:
        _waiting_users.pop(user_id, None)

    # 3. Fetch report via report_service
    try:
        report_data = await report_service.get_report_for_date(date_str)
        text = format_single_day_text(report_data)

        await message.reply(
            text,
            parse_mode="Markdown",
            reply_markup=report_inline_keyboard(date_str)
        )
        # Restore main persistent navigation
        await message.reply(
            "Quyidagi menyudan boshqa hisobotlarni ham tanlashingiz mumkin:",
            reply_markup=main_reply_keyboard
        )
    except Exception as err:
        logger.error(f"[process_date_input error] {err}", exc_info=True)
        await message.reply(
            f"❌ Hisobotni olishda xatolik yuz berdi: {err}",
            reply_markup=main_reply_keyboard
        )


@router.message(Command("report"))
async def handle_report_cmd(message: Message):
    parts = (message.text or "").split()
    if len(parts) < 2:
        await message.reply(
            "Iltimos, sanani ko'rsating. Masalan: `/report 2026-09-08`",
            parse_mode="Markdown",
            reply_markup=main_reply_keyboard
        )
        return

    await process_date_input(message, parts[1])


@router.message(F.text)
async def handle_date_text(message: Message):
    text = (message.text or "").strip()
    user_id = message.from_user.id if message.from_user else None

    # Check if text matches YYYY-MM-DD pattern or user is in waiting state
    is_pattern = bool(re.match(r"^\d{4}-\d{2}-\d{2}$", text))
    is_waiting = False
    if user_id and user_id in _waiting_users:
        # Expire after 5 minutes
        if time.time() - _waiting_users[user_id] < 300:
            is_waiting = True
        else:
            _waiting_users.pop(user_id, None)

    if is_pattern or is_waiting:
        await process_date_input(message, text)
