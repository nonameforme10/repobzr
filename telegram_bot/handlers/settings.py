"""
Bazar Telegram Bot — Settings & Reports Catalog Handlers (aiogram 3)
"""

from aiogram import Router, F
from aiogram.types import Message
from .. import db, report_service
from ..config import (
    TELEGRAM_DAILY_REPORT_ENABLED,
    TELEGRAM_DAILY_REPORT_TIME,
    TELEGRAM_REPORT_CHAT_IDS,
    TIMEZONE
)
from ..keyboards import main_reply_keyboard

router = Router(name="settings")


@router.message(F.text == "⚙️ Sozlamalar")
async def handle_settings(message: Message):
    db_ok = await db.is_healthy()
    today_str = report_service.get_tashkent_today()
    recipients_count = len(TELEGRAM_REPORT_CHAT_IDS)

    text = (
        "⚙️ *BAZAR TIZIM SOZLAMALARI*:\n\n"
        f"• 🟢 *Bot tili & Muhit:* `Python (aiogram 3.30)`\n"
        f"• 🗄 *Ma'lumotlar bazasi:* {'Ulangan (PostgreSQL 16)' if db_ok else '❌ Aloqa yo\'q'}\n"
        f"• 🕒 *Vaqt mintaqasi:* `{TIMEZONE} (UTC+05:00)`\n"
        f"• 📅 *Bugungi sana:* `{today_str}`\n\n"
        "🔔 *Avtomatik hisobot (Nightly Push):*\n"
        f"• Holati: {'✅ Yoqilgan' if TELEGRAM_DAILY_REPORT_ENABLED else '❌ O\'chirilgan'}\n"
        f"• Jo'natish vaqti: `{TELEGRAM_DAILY_REPORT_TIME} Tashkent`\n"
        f"• Qabul qiluvchilar soni: `{recipients_count} ta chat`\n\n"
        "_Barcha hisob-kitoblar to'g'ridan-to'g'ri PostgreSQL bazasi asosida amalga oshiriladi._"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=main_reply_keyboard)


@router.message(F.text == "📋 Hisobotlar")
async def handle_reports_catalog(message: Message):
    text = (
        "📋 *BAZAR HISOBOTLAR BO'LIMI*:\n\n"
        "Kerakli hisobot turini pastdagi doimiy menyudan tanlang:\n\n"
        "• 📊 *Bugun* — Bugungi kun davomidagi barcha savdo, chegirma, chiqim va kassa hisoboti.\n"
        "• ⏮ *Kecha* — Kechagi kunning to'liq yakuniy hisoboti.\n"
        "• 📈 *Oxirgi 7 kun* — Haftalik savdo ko'rsatkichlari, sotilgan tovarlar soni va kassa balansi.\n"
        "• 📅 *Boshqa sana* — O'tgan istalgan kalendar sanasi bo'yicha to'liq hisobot.\n\n"
        "_Har bir hisobot ostida 📸 PNG Rasm va 📑 Excel Fayl yuklash imkoniyati mavjud._"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=main_reply_keyboard)


@router.message(F.text == "/version")
async def handle_version_cmd(message: Message):
    from ..version_checker import read_version_info, get_last_broadcasted_version
    current = read_version_info() or "Noma'lum"
    last = await get_last_broadcasted_version() or "Hali yuborilmagan"

    text = (
        f"🏷 *BAZAR BOT VERSIYASI*:\n\n"
        f"• *Hozirgi versiya (version.txt):* `{current}`\n"
        f"• *Oxirgi tarqatilgan versiya:* `{last}`\n\n"
        f"_Agar version.txt faylidagi matn o'zgarsa (masalan, v1.2), bot avtomatik tarzda barcha adminlarga xabar yuboradi va menyuni yangilaydi._"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=main_reply_keyboard)
