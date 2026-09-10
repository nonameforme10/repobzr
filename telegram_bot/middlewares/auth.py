"""
Telegram Bot Numeric ID Whitelist Authorization Middleware (aiogram 3)
"""

import logging
from typing import Callable, Dict, Any, Awaitable
from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Message, CallbackQuery
from ..config import TELEGRAM_ADMIN_IDS

logger = logging.getLogger(__name__)


class AuthMiddleware(BaseMiddleware):
    """
    Ensures only authorized Telegram numeric user IDs can interact with the bot.
    Never relies on usernames. Rejects unauthorized access with a clean alert.
    """

    async def __call__(
        self,
        handler: Callable[[TelegramObject, Dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: Dict[str, Any]
    ) -> Any:
        user = data.get("event_from_user")
        if not user:
            return await handler(event, data)

        if TELEGRAM_ADMIN_IDS and user.id not in TELEGRAM_ADMIN_IDS:
            username = getattr(user, "username", "no-username")
            logger.warning(f"[auth] Unauthorized access attempt from ID {user.id} (@{username})")

            rejection_text = "⛔ Sizda ushbu botdan foydalanish huquqi yo'q."
            if isinstance(event, CallbackQuery):
                await event.answer(rejection_text, show_alert=True)
                return
            elif isinstance(event, Message):
                await event.reply(rejection_text)
                return
            return

        return await handler(event, data)
