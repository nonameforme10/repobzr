"""
Bazar (SalesTrack) — Centralized Report Service (Python)
SINGLE SOURCE OF TRUTH for all accounting, sales, and expense calculations.

CORE RULES:
1. Timezone: Fixed to Asia/Tashkent (UTC+05:00). Half-open interval [startOfDay, startOfNextDay).
2. Gross Sales = sum(sale.subtotal) (Integer so'm)
3. Manual Discount = sum(sale.discount) (verbatim, never invented or rounded)
4. Net Sales = Gross Sales - Manual Discount
5. Items Sold = sum(sale_items.quantity)
6. Transaction Count = count(sales)
7. Chiqim = sum(cash_out monetary amounts)
8. Net Cash = Net Sales - Chiqim (Assumption: all sales are currently cash transactions)
9. Future dates are strictly rejected before any DB query.
10. All monetary values are strictly whole integer so'm values.
"""

import calendar
import datetime
import json
import logging
from typing import Dict, Any, Tuple, Optional
import zoneinfo

from .db import get_pool
from .config import TIMEZONE

logger = logging.getLogger(__name__)

TZ = zoneinfo.ZoneInfo(TIMEZONE)
MS_PER_DAY = 24 * 60 * 60 * 1000


def get_tashkent_today() -> str:
    """Get current date string in Asia/Tashkent (YYYY-MM-DD)."""
    now = datetime.datetime.now(TZ)
    return now.strftime("%Y-%m-%d")


def get_tashkent_yesterday() -> str:
    """Get yesterday's date string in Asia/Tashkent (YYYY-MM-DD)."""
    now = datetime.datetime.now(TZ)
    yesterday = now - datetime.timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")


def is_valid_date_string(date_str: str) -> bool:
    """
    Validate YYYY-MM-DD date format and strict calendar existence.
    Rejects invalid leap years, February 30/31, April 31, etc.
    """
    if not isinstance(date_str, str):
        return False
    date_str = date_str.strip()
    parts = date_str.split("-")
    if len(parts) != 3:
        return False

    y_str, m_str, d_str = parts
    if not (y_str.isdigit() and m_str.isdigit() and d_str.isdigit()):
        return False

    y, m, d = int(y_str), int(m_str), int(d_str)
    if y < 2000 or y > 2100 or m < 1 or m > 12 or d < 1:
        return False

    # Get max days for month m in year y
    _, max_days = calendar.monthrange(y, m)
    return d <= max_days


def get_tashkent_day_bounds(date_str: str) -> Tuple[int, int]:
    """
    Compute half-open [startOfDay, startOfNextDay) epoch timestamps (in ms)
    for a YYYY-MM-DD date in Asia/Tashkent (UTC+05:00).
    """
    y, m, d = map(int, date_str.split("-"))
    dt_start = datetime.datetime(y, m, d, 0, 0, 0, 0, tzinfo=TZ)
    start_of_day = int(dt_start.timestamp() * 1000)
    start_of_next_day = start_of_day + MS_PER_DAY
    return start_of_day, start_of_next_day


def format_tashkent_time(ts_ms: Optional[int], fmt: str = "time") -> str:
    """Format millisecond epoch timestamp in Asia/Tashkent."""
    if not ts_ms:
        return ""
    dt = datetime.datetime.fromtimestamp(ts_ms / 1000, tz=TZ)
    if fmt == "time":
        return dt.strftime("%H:%M")
    return dt.strftime("%Y-%m-%d %H:%M")


async def get_report_for_date(date_str: str) -> Dict[str, Any]:
    """
    Fetch and compute single-day normalized report data.
    Single source of truth for financial accounting.
    """
    trimmed = (date_str or "").strip()

    # 1. Validation: Format & Calendar existence
    if not is_valid_date_string(trimmed):
        raise ValueError(f"INVALID_DATE_FORMAT: Sana noto'g'ri ko'rsatilgan ({date_str}). Format: YYYY-MM-DD")

    # 2. Validation: Future date rejection
    today_str = get_tashkent_today()
    if trimmed > today_str:
        err = ValueError(f"FUTURE_DATE: Kelajakdagi sana uchun hisobot mavjud emas. Bugungi sana: {today_str}")
        err.today_str = today_str
        raise err

    # 3. Compute half-open interval bounds in Asia/Tashkent
    start_of_day, start_of_next_day = get_tashkent_day_bounds(trimmed)

    pool = get_pool()
    if pool is None:
        raise RuntimeError("DATABASE_UNAVAILABLE: Ma'lumotlar bazasiga ulanish mavjud emas.")

    async with pool.acquire() as conn:
        # 4. Query multi-item sales transactions
        sales_rows = await conn.fetch("""
            SELECT 
                s.id,
                s.seller_id,
                ROUND(COALESCE(s.subtotal, 0))::bigint AS subtotal,
                ROUND(COALESCE(s.discount, 0))::bigint AS discount,
                ROUND(COALESCE(s.total, 0))::bigint AS total,
                s.created_at::bigint AS created_at,
                s.notes,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', si.id,
                            'productId', si.product_id,
                            'productName', si.product_name_snapshot,
                            'quantity', si.quantity::int,
                            'basePrice', ROUND(COALESCE(si.base_price, 0))::bigint,
                            'salePrice', ROUND(COALESCE(si.sale_price, 0))::bigint,
                            'subtotal', ROUND(COALESCE(si.subtotal, 0))::bigint,
                            'allocatedDiscount', ROUND(COALESCE(si.allocated_discount, 0))::bigint
                        ) ORDER BY si.id
                    ) FILTER (WHERE si.id IS NOT NULL), '[]'::json
                ) AS items_json
            FROM sales s
            LEFT JOIN sale_items si ON s.id = si.sale_id
            WHERE s.created_at >= $1 
              AND s.created_at < $2 
              AND s.is_deleted = FALSE 
              AND s.status = 'COMPLETED'
            GROUP BY s.id
            ORDER BY s.created_at ASC
        """, start_of_day, start_of_next_day)

        # 5. Query legacy activities (sales without sale_id) if any exist
        legacy_sales_rows = await conn.fetch("""
            SELECT 
                id,
                timestamp::bigint AS timestamp,
                product_id,
                product_name,
                quantity::int AS quantity,
                ROUND(COALESCE(subtotal, 0))::bigint AS subtotal,
                ROUND(COALESCE(discount, 0))::bigint AS discount,
                notes
            FROM activities
            WHERE type = 'sale' 
              AND sale_id IS NULL 
              AND timestamp >= $1 
              AND timestamp < $2
            ORDER BY timestamp ASC
        """, start_of_day, start_of_next_day)

        # 6. Query Chiqim (cash_out) expenses
        cash_out_rows = await conn.fetch("""
            SELECT 
                id,
                timestamp::bigint AS timestamp,
                ROUND(COALESCE(quantity, 0))::bigint AS amount,
                COALESCE(product_name, notes, 'Kassadan chiqim') AS reason,
                notes
            FROM activities
            WHERE type = 'cash_out' 
              AND timestamp >= $1 
              AND timestamp < $2
            ORDER BY timestamp ASC
        """, start_of_day, start_of_next_day)

    # 7. Aggregate Totals strictly in integer units
    gross_sales = 0
    manual_discount = 0
    items_sold = 0
    transaction_count = len(sales_rows) + len(legacy_sales_rows)

    aggregated_items_map = {}
    sales_list = []

    # Process multi-item sales
    for r in sales_rows:
        subtotal = int(r["subtotal"])
        discount = int(r["discount"])
        total = int(r["total"])
        created_at = int(r["created_at"])

        gross_sales += subtotal
        manual_discount += discount

        items = json.loads(r["items_json"]) if isinstance(r["items_json"], str) else (r["items_json"] or [])
        for it in items:
            q = int(it.get("quantity") or 0)
            items_sold += q
            key = it.get("productId") or it.get("productName")
            if key not in aggregated_items_map:
                aggregated_items_map[key] = {
                    "productId": it.get("productId"),
                    "name": it.get("productName") or "Mahsulot",
                    "quantity": 0,
                    "unitPrice": int(it.get("salePrice") or it.get("basePrice") or 0),
                    "total": 0
                }
            aggregated_items_map[key]["quantity"] += q
            aggregated_items_map[key]["total"] += int(it.get("subtotal") or 0)

        sales_list.append({
            "id": r["id"],
            "sellerId": r["seller_id"],
            "subtotal": subtotal,
            "discount": discount,
            "total": total,
            "createdAt": created_at,
            "timeFormatted": format_tashkent_time(created_at, "time"),
            "notes": r["notes"],
            "itemsCount": len(items),
            "items": items
        })

    # Process legacy sales
    for r in legacy_sales_rows:
        subtotal = int(r["subtotal"])
        discount = int(r["discount"])
        q = int(r["quantity"] or 0)
        ts = int(r["timestamp"])

        gross_sales += subtotal
        manual_discount += discount
        items_sold += q

        key = r["product_id"] or r["product_name"]
        if key not in aggregated_items_map:
            unit_price = round(subtotal / q) if q > 0 else 0
            aggregated_items_map[key] = {
                "productId": r["product_id"],
                "name": r["product_name"] or "Mahsulot",
                "quantity": 0,
                "unitPrice": unit_price,
                "total": 0
            }
        aggregated_items_map[key]["quantity"] += q
        aggregated_items_map[key]["total"] += subtotal

    net_sales = gross_sales - manual_discount

    # Process Chiqim
    total_chiqim = 0
    cash_outs = []
    for r in cash_out_rows:
        amt = int(r["amount"])
        total_chiqim += amt
        ts = int(r["timestamp"])
        cash_outs.append({
            "id": r["id"],
            "amount": amt,
            "reason": r["reason"] or "Kassadan chiqim",
            "notes": r["notes"],
            "timestamp": ts,
            "timeFormatted": format_tashkent_time(ts, "time")
        })

    # Net cash assumption: all sales currently cash transactions
    net_cash = net_sales - total_chiqim

    items_list = sorted(
        aggregated_items_map.values(),
        key=lambda x: x["total"],
        reverse=True
    )

    return {
        "date": trimmed,
        "timezone": TIMEZONE,
        "totals": {
            "grossSales": gross_sales,
            "discount": manual_discount,
            "netSales": net_sales,
            "itemsSold": items_sold,
            "transactionCount": transaction_count,
            "chiqim": total_chiqim,
            "netCash": net_cash
        },
        "items": items_list,
        "cashOuts": cash_outs,
        "sales": sales_list
    }


async def get_7day_report(end_date_str: Optional[str] = None) -> Dict[str, Any]:
    """
    Fetch 7-day daily summary rollup for Asia/Tashkent up to end_date_str.
    Returns 7 daily summary rows and rollup totals.
    """
    target_end = (end_date_str.strip() if end_date_str and is_valid_date_string(end_date_str) 
                  else get_tashkent_today())

    y, m, d = map(int, target_end.split("-"))
    base_date = datetime.date(y, m, d)

    days = []
    for i in range(6, -1, -1):
        dt = base_date - datetime.timedelta(days=i)
        days.append(dt.strftime("%Y-%m-%d"))

    months_uz = ["Yan", "Fev", "Mar", "Apr", "May", "Iyun", "Iyul", "Avg", "Sen", "Okt", "Noy", "Dek"]

    daily_reports = []
    rollup_gross = 0
    rollup_discount = 0
    rollup_net_sales = 0
    rollup_items_sold = 0
    rollup_transactions = 0
    rollup_chiqim = 0
    rollup_net_cash = 0

    for d_str in days:
        report = await get_report_for_date(d_str)
        parts = d_str.split("-")
        m_num = int(parts[1])
        d_num = parts[2]
        display_date = f"{d_num} {months_uz[m_num - 1]}"

        daily_reports.append({
            "date": d_str,
            "displayDate": display_date,
            "totals": report["totals"]
        })

        t = report["totals"]
        rollup_gross += t["grossSales"]
        rollup_discount += t["discount"]
        rollup_net_sales += t["netSales"]
        rollup_items_sold += t["itemsSold"]
        rollup_transactions += t["transactionCount"]
        rollup_chiqim += t["chiqim"]
        rollup_net_cash += t["netCash"]

    return {
        "startDate": days[0],
        "endDate": days[-1],
        "timezone": TIMEZONE,
        "dailyReports": daily_reports,
        "rollup": {
            "grossSales": rollup_gross,
            "discount": rollup_discount,
            "netSales": rollup_net_sales,
            "itemsSold": rollup_items_sold,
            "transactionCount": rollup_transactions,
            "chiqim": rollup_chiqim,
            "netCash": rollup_net_cash
        }
    }
