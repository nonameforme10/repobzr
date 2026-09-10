"""
Bazar Telegram Bot Configuration Module
Loads environment variables from backend/.env or local .env file.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Try to load backend/.env first, then root .env
BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
BACKEND_ENV = ROOT_DIR / "backend" / ".env"

if BACKEND_ENV.exists():
    load_dotenv(BACKEND_ENV)
else:
    load_dotenv(ROOT_DIR / ".env")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()

# Parse comma-separated numeric Telegram Admin IDs (supports TELEGRAM_ADMIN_IDS or TELEGRAM_ADMIN_ID)
_raw_admin_ids = (os.getenv("TELEGRAM_ADMIN_IDS") or os.getenv("TELEGRAM_ADMIN_ID") or "").strip()
TELEGRAM_ADMIN_IDS = set()
for s in _raw_admin_ids.split(","):
    s = s.strip().strip("'\"")
    if s.isdigit():
        TELEGRAM_ADMIN_IDS.add(int(s))

# Parse comma-separated Report Chat IDs (default to Admin IDs if not specified)
_raw_report_chat_ids = os.getenv("TELEGRAM_REPORT_CHAT_IDS", "").strip()
TELEGRAM_REPORT_CHAT_IDS = []
if _raw_report_chat_ids:
    for s in _raw_report_chat_ids.split(","):
        s = s.strip()
        if s:
            TELEGRAM_REPORT_CHAT_IDS.append(int(s) if s.lstrip("-").isdigit() else s)
else:
    TELEGRAM_REPORT_CHAT_IDS = list(TELEGRAM_ADMIN_IDS)

# Database Connection URL (Defaults to local PostgreSQL 16)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://bozor_user:bz_sec_9f8e4a1b7c3d2e0f8a6b4c2d0e1f3a5b@127.0.0.1:5432/bozor_db"
)

# Automated Daily Report Push Settings
TELEGRAM_DAILY_REPORT_ENABLED = os.getenv("TELEGRAM_DAILY_REPORT_ENABLED", "true").lower() != "false"
TELEGRAM_DAILY_REPORT_TIME = os.getenv("TELEGRAM_DAILY_REPORT_TIME", "21:00").strip()
TIMEZONE = "Asia/Tashkent"
