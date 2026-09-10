"""
Bazar Telegram Bot — Main Entry Point (Python / aiogram 3)
Run with: python -m telegram_bot.run
"""

import asyncio
import logging
import sys
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from .config import TELEGRAM_BOT_TOKEN
from .db import init_db_pool, close_db_pool
from .middlewares.auth import AuthMiddleware
from .handlers import main_router
from .scheduler import start_scheduler, stop_scheduler

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("bazar_bot")


async def main():
    if not TELEGRAM_BOT_TOKEN:
        logger.error("[FATAL] TELEGRAM_BOT_TOKEN is not configured in .env. Bot cannot start.")
        sys.exit(1)

    logger.info("Initializing Bazar Telegram Bot (Python 3.14 / aiogram 3)...")

    # 1. Initialize database connection pool
    await init_db_pool()

    # 2. Create Bot and Dispatcher
    bot = Bot(
        token=TELEGRAM_BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.MARKDOWN)
    )
    dp = Dispatcher()

    # 3. Mount Whitelist Authorization Middleware
    dp.message.middleware(AuthMiddleware())
    dp.callback_query.middleware(AuthMiddleware())

    # 4. Mount Handlers Router
    dp.include_router(main_router)

    # 5. Start Nightly Push Scheduler
    start_scheduler(bot)

    # 6. Start Polling
    try:
        bot_info = await bot.get_me()
        logger.info(f"Bot connected successfully as @{bot_info.username} (ID: {bot_info.id})")
        logger.info("Starting long-polling with drop_pending_updates=True...")
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    except (KeyboardInterrupt, SystemExit):
        logger.info("Termination signal received.")
    finally:
        logger.info("Shutting down Bazar Telegram Bot...")
        stop_scheduler()
        await close_db_pool()
        await bot.session.close()
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass
