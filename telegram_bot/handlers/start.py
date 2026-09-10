"""
Bazar Telegram Bot — Start & Help Handlers (aiogram 3)
"""

from aiogram import Router
from aiogram.filters import CommandStart, Command
from aiogram.types import Message
from ..keyboards import main_reply_keyboard

router = Router(name="start")


@router.message(CommandStart())
async def cmd_start(message: Message):
    first_name = message.from_user.first_name if message.from_user else "Hurmatli foydalanuvchi"
    text = (
        f"Assalomu alaykum, *{first_name}*! 👋\n\n"
        f"*BAZAR* do'kon boshqaruvi va hisobotlar botiga xush kelibsiz.\n\n"
        f"Ushbu bot orqali do'koningizning kunlik savdo ko'rsatkichlari, kassa tushumi, "
        f"chiqimlar va davriy hisobotlarini to'g'ridan-to'g'ri Telegram orqali olishingiz mumkin.\n\n"
        f"👇 *Quyidagi menyu orqali kerakli amalni tanlang:*"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=main_reply_keyboard)


@router.message(Command("help"))
async def cmd_help(message: Message):
    text = (
        f"📖 *BAZAR BOT BUYRUQLARI*:\n\n"
        f"• 📊 *Bugun* — Bugungi kunlik savdo va kassa hisoboti\n"
        f"• ⏮ *Kecha* — Kechagi kun yakuniy hisoboti\n"
        f"• 📈 *Oxirgi 7 kun* — Haftalik tahlil va dinamika\n"
        f"• 📅 *Boshqa sana* — Istalgan sana bo'yicha hisobot (YYYY-MM-DD)\n"
        f"• 📋 *Hisobotlar* — Barcha hisobotlar ro'yxati\n"
        f"• ⚙️ *Sozlamalar* — Tizim holati va avtomatik hisobot sozlamalari\n\n"
        f"*Qo'shimcha buyruqlar:*\n"
        f"`/today` — Bugungi hisobot\n"
        f"`/yesterday` — Kechagi hisobot\n"
        f"`/7days` — 7 kunlik hisobot\n"
        f"`/report YYYY-MM-DD` — Muayyan sana hisoboti"
    )
    await message.reply(text, parse_mode="Markdown", reply_markup=main_reply_keyboard)
