"""
Bazar Telegram Bot — Keyboards Module (aiogram 3)

CORE CONTRACT:
- ReplyKeyboardMarkup: Persistent main navigation above the input box.
- InlineKeyboardMarkup: Contextual actions attached directly to specific report messages.
"""

from aiogram.types import (
    ReplyKeyboardMarkup,
    KeyboardButton,
    InlineKeyboardMarkup,
    InlineKeyboardButton
)

# 1. Main Persistent Reply Keyboard
main_reply_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="📊 Bugun"), KeyboardButton(text="⏮ Kecha")],
        [KeyboardButton(text="📈 Oxirgi 7 kun"), KeyboardButton(text="📅 Boshqa sana")],
        [KeyboardButton(text="📋 Hisobotlar"), KeyboardButton(text="⚙️ Sozlamalar")]
    ],
    resize_keyboard=True,
    is_persistent=True
)

# 2. Cancel Reply Keyboard
cancel_reply_keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="❌ Bekor qilish")]
    ],
    resize_keyboard=True,
    is_persistent=True
)


def report_inline_keyboard(date_str: str) -> InlineKeyboardMarkup:
    """Contextual Inline Keyboard for single-day report."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="📸 PNG Rasm", callback_data=f"export:png:{date_str}"),
                InlineKeyboardButton(text="📑 Excel Fayl", callback_data=f"export:excel:{date_str}")
            ]
        ]
    )


def seven_day_inline_keyboard(end_date_str: str) -> InlineKeyboardMarkup:
    """Contextual Inline Keyboard for 7-day executive report."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="📸 PNG Rasm", callback_data=f"export7:png:{end_date_str}"),
                InlineKeyboardButton(text="📑 Excel Fayl", callback_data=f"export7:excel:{end_date_str}")
            ]
        ]
    )
