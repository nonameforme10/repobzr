from aiogram import Router
from .start import router as start_router
from .reports import router as reports_router
from .dates import router as dates_router
from .settings import router as settings_router

main_router = Router(name="main_router")
main_router.include_router(start_router)
main_router.include_router(reports_router)
main_router.include_router(settings_router)
main_router.include_router(dates_router)

__all__ = ["main_router"]
