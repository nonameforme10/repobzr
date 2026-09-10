"""
Bazar Telegram Bot — Reports Handlers (aiogram 3)
Handles 'Bugun', 'Kecha', 'Oxirgi 7 kun', and associated inline exports.
"""

import logging
from aiogram import Router, F
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery, BufferedInputFile
from .. import report_service, report_exporter
from ..keyboards import report_inline_keyboard, seven_day_inline_keyboard, main_reply_keyboard

logger = logging.getLogger(__name__)
router = Router(name="reports")


def format_single_day_text(report_data: dict, label: str = "") -> str:
    """Format single-day summary text for Telegram message."""
    date_str = report_data["date"]
    totals = report_data["totals"]
    tag = f" ({label})" if label else ""

    lines = [
        f"📊 *BAZAR — {date_str}{tag}*\n",
        f"💰 *Jami Savdo (Gross):*  {report_exporter.format_soom(totals['grossSales'])} so'm"
    ]

    if totals["discount"] > 0:
        lines.append(f"🏷 *Chegirma:*  −{report_exporter.format_soom(totals['discount'])} so'm")

    chiqim_str = f"−{report_exporter.format_soom(totals['chiqim'])}" if totals["chiqim"] > 0 else "0"
    lines.extend([
        f"💵 *Sof Savdo (Net):*  *{report_exporter.format_soom(totals['netSales'])} so'm*\n",
        f"📦 *Sotildi:*  {totals['itemsSold']} dona ({totals['transactionCount']} ta savdo)",
        f"💸 *Chiqim:*  {chiqim_str} so'm",
        f"🏦 *Sof Kassa:*  *{report_exporter.format_soom(totals['netCash'])} so'm*"
    ])

    cash_outs = report_data.get("cashOuts", [])
    if cash_outs:
        lines.append("\n💸 *Chiqimlar ro'yxati:*")
        for c in cash_outs:
            lines.append(f"• `{c.get('timeFormatted', '--:--')}` — {c['reason']}: *−{report_exporter.format_soom(c['amount'])} so'm*")

    return "\n".join(lines)


def format_7day_text(seven_day_data: dict) -> str:
    """Format 7-day summary text for Telegram message."""
    lines = [
        "📈 *BAZAR — 7 KUNLIK SAVDO TAHLILI*",
        f"📅 _{seven_day_data['startDate']} dan {seven_day_data['endDate']} gacha_\n"
    ]

    for d in seven_day_data["dailyReports"]:
        net = report_exporter.format_soom(d["totals"]["netSales"])
        lbl = d.get("displayDate") or d["date"]
        lines.append(f"• *{lbl}:*  {net} so'm  _({d['totals']['itemsSold']} dona)_")

    rollup = seven_day_data["rollup"]
    lines.extend([
        "─────────────────────────",
        f"💰 *7 Kunlik Savdo:*  *{report_exporter.format_soom(rollup['netSales'])} so'm*",
        f"📦 *Jami Sotildi:*  {rollup['itemsSold']} dona ({rollup['transactionCount']} ta savdo)",
        f"💸 *Jami Chiqim:*  −{report_exporter.format_soom(rollup['chiqim'])} so'm",
        f"🏦 *Sof Kassa:*  *{report_exporter.format_soom(rollup['netCash'])} so'm*"
    ])

    return "\n".join(lines)


# ============================================================================
# TEXT & COMMAND HANDLERS
# ============================================================================
@router.message(F.text == "📊 Bugun")
@router.message(Command("today"))
async def handle_today(message: Message):
    try:
        today_str = report_service.get_tashkent_today()
        report_data = await report_service.get_report_for_date(today_str)
        text = format_single_day_text(report_data, "Bugun")
        await message.reply(
            text,
            parse_mode="Markdown",
            reply_markup=report_inline_keyboard(today_str)
        )
    except Exception as err:
        logger.error(f"[handle_today error] {err}", exc_info=True)
        await message.reply(f"❌ Hisobotni olishda xatolik: {err}")


@router.message(F.text == "⏮ Kecha")
@router.message(Command("yesterday"))
async def handle_yesterday(message: Message):
    try:
        yesterday_str = report_service.get_tashkent_yesterday()
        report_data = await report_service.get_report_for_date(yesterday_str)
        text = format_single_day_text(report_data, "Kecha")
        await message.reply(
            text,
            parse_mode="Markdown",
            reply_markup=report_inline_keyboard(yesterday_str)
        )
    except Exception as err:
        logger.error(f"[handle_yesterday error] {err}", exc_info=True)
        await message.reply(f"❌ Hisobotni olishda xatolik: {err}")


@router.message(F.text == "📈 Oxirgi 7 kun")
@router.message(Command("7days"))
async def handle_7days(message: Message):
    try:
        seven_day_data = await report_service.get_7day_report()
        text = format_7day_text(seven_day_data)
        await message.reply(
            text,
            parse_mode="Markdown",
            reply_markup=seven_day_inline_keyboard(seven_day_data["endDate"])
        )
    except Exception as err:
        logger.error(f"[handle_7days error] {err}", exc_info=True)
        await message.reply(f"❌ 7 kunlik hisobotni olishda xatolik: {err}")


# ============================================================================
# CALLBACK QUERY EXPORT HANDLERS
# ============================================================================
@router.callback_query(F.data.startswith("export:png:"))
async def cb_export_png(callback: CallbackQuery):
    date_str = callback.data.replace("export:png:", "").strip()
    if not report_service.is_valid_date_string(date_str):
        await callback.answer("❌ Noto'g'ri sana formati", show_alert=True)
        return

    await callback.answer("📸 PNG rasm tayyorlanmoqda...")
    status_msg = await callback.message.reply(f"⏳ {date_str} sanasi uchun PNG rasm tayyorlanmoqda...")

    try:
        report_data = await report_service.get_report_for_date(date_str)
        png_bytes = report_exporter.generate_png_report(report_data)

        caption = (
            f"📸 *Bazar — Kunlik savdo hisoboti*\n"
            f"📅 Sana: `{date_str}`\n"
            f"🏦 Sof kassa: *{report_exporter.format_soom(report_data['totals']['netCash'])} so'm*"
        )
        file = BufferedInputFile(png_bytes, filename=f"Bazar_Hisobot_{date_str}.png")
        await callback.message.reply_photo(photo=file, caption=caption, parse_mode="Markdown", reply_markup=main_reply_keyboard)

        try:
            await status_msg.delete()
        except Exception:
            pass
    except Exception as err:
        logger.error(f"[cb_export_png error] {err}", exc_info=True)
        await callback.message.reply(f"❌ PNG yaratishda xatolik: {err}")


@router.callback_query(F.data.startswith("export:excel:"))
async def cb_export_excel(callback: CallbackQuery):
    date_str = callback.data.replace("export:excel:", "").strip()
    if not report_service.is_valid_date_string(date_str):
        await callback.answer("❌ Noto'g'ri sana formati", show_alert=True)
        return

    await callback.answer("📑 Excel fayl tayyorlanmoqda...")
    status_msg = await callback.message.reply(f"⏳ {date_str} sanasi uchun Excel fayl tayyorlanmoqda...")

    try:
        report_data = await report_service.get_report_for_date(date_str)
        excel_bytes = report_exporter.generate_excel_report(report_data)

        caption = (
            f"📑 *Bazar — Kunlik savdo hisoboti (.xlsx)*\n"
            f"📅 Sana: `{date_str}`\n"
            f"🏦 Sof kassa: *{report_exporter.format_soom(report_data['totals']['netCash'])} so'm*"
        )
        file = BufferedInputFile(excel_bytes, filename=f"Bazar_Hisobot_{date_str}.xlsx")
        await callback.message.reply_document(document=file, caption=caption, parse_mode="Markdown", reply_markup=main_reply_keyboard)

        try:
            await status_msg.delete()
        except Exception:
            pass
    except Exception as err:
        logger.error(f"[cb_export_excel error] {err}", exc_info=True)
        await callback.message.reply(f"❌ Excel yaratishda xatolik: {err}")


@router.callback_query(F.data.startswith("export7:png:"))
async def cb_export7_png(callback: CallbackQuery):
    end_date_str = callback.data.replace("export7:png:", "").strip()
    await callback.answer("📸 7 kunlik PNG tayyorlanmoqda...")
    status_msg = await callback.message.reply("⏳ 7 kunlik tahlil PNG rasmi tayyorlanmoqda...")

    try:
        seven_day_data = await report_service.get_7day_report(end_date_str)
        png_bytes = report_exporter.generate_7day_png_report(seven_day_data)

        caption = (
            f"📸 *Bazar — 7 Kunlik savdo tahlili*\n"
            f"📅 Davr: `{seven_day_data['startDate']}` — `{seven_day_data['endDate']}`\n"
            f"🏦 7 kunlik sof kassa: *{report_exporter.format_soom(seven_day_data['rollup']['netCash'])} so'm*"
        )
        file = BufferedInputFile(png_bytes, filename=f"Bazar_7Kunlik_{seven_day_data['endDate']}.png")
        await callback.message.reply_photo(photo=file, caption=caption, parse_mode="Markdown", reply_markup=main_reply_keyboard)

        try:
            await status_msg.delete()
        except Exception:
            pass
    except Exception as err:
        logger.error(f"[cb_export7_png error] {err}", exc_info=True)
        await callback.message.reply(f"❌ 7 kunlik PNG yaratishda xatolik: {err}")


@router.callback_query(F.data.startswith("export7:excel:"))
async def cb_export7_excel(callback: CallbackQuery):
    end_date_str = callback.data.replace("export7:excel:", "").strip()
    await callback.answer("📑 7 kunlik Excel tayyorlanmoqda...")
    status_msg = await callback.message.reply("⏳ 7 kunlik tahlil Excel fayli tayyorlanmoqda...")

    try:
        seven_day_data = await report_service.get_7day_report(end_date_str)
        excel_bytes = report_exporter.generate_7day_excel_report(seven_day_data)

        caption = (
            f"📑 *Bazar — 7 Kunlik savdo tahlili (.xlsx)*\n"
            f"📅 Davr: `{seven_day_data['startDate']}` — `{seven_day_data['endDate']}`\n"
            f"🏦 7 kunlik sof kassa: *{report_exporter.format_soom(seven_day_data['rollup']['netCash'])} so'm*"
        )
        file = BufferedInputFile(excel_bytes, filename=f"Bazar_7Kunlik_{seven_day_data['endDate']}.xlsx")
        await callback.message.reply_document(document=file, caption=caption, parse_mode="Markdown", reply_markup=main_reply_keyboard)

        try:
            await status_msg.delete()
        except Exception:
            pass
    except Exception as err:
        logger.error(f"[cb_export7_excel error] {err}", exc_info=True)
        await callback.message.reply(f"❌ 7 kunlik Excel yaratishda xatolik: {err}")
