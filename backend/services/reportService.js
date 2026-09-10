/**
 * Bazar (SalesTrack) — Centralized Report Service
 * SINGLE SOURCE OF TRUTH for all accounting, sales, and expense calculations.
 * 
 * CORE RULES:
 * 1. Timezone: Fixed to Asia/Tashkent (UTC+05:00). Half-open interval [startOfDay, startOfNextDay).
 * 2. Gross Sales = sum(sale.subtotal) (Integer so'm)
 * 3. Manual Discount = sum(sale.discount) (verbatim, never invented or rounded)
 * 4. Net Sales = Gross Sales - Manual Discount
 * 5. Items Sold = sum(sale_items.quantity)
 * 6. Transaction Count = count(sales)
 * 7. Chiqim = sum(cash_out monetary amounts)
 * 8. Net Cash = Net Sales - Chiqim (Assumption: all sales are currently cash transactions)
 * 9. Future dates are strictly rejected before any DB query.
 * 10. All monetary values are strictly whole integer so'm values.
 */

const { pool } = require('../db');

const TIMEZONE = 'Asia/Tashkent';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Get current date string in Asia/Tashkent (YYYY-MM-DD)
 */
function getTashkentToday() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(now);
}

/**
 * Get yesterday's date string in Asia/Tashkent (YYYY-MM-DD)
 */
function getTashkentYesterday() {
  const todayStr = getTashkentToday();
  const [y, m, d] = todayStr.split('-').map(Number);
  const prevDate = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(prevDate);
}

/**
 * Validate YYYY-MM-DD date format and calendar existence
 * Rejects invalid leap years, February 30/31, April 31, etc.
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidDateString(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const match = dateStr.trim().match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) return false;

  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);

  // Month index `m` with day `0` resolves to the last day of month `m`
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

/**
 * Compute half-open [startOfDay, startOfNextDay) epoch timestamps (in ms)
 * for a YYYY-MM-DD date in Asia/Tashkent (UTC+05:00)
 * @param {string} dateStr
 * @returns {{ startOfDay: number, startOfNextDay: number }}
 */
function getTashkentDayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Asia/Tashkent is UTC+5:00 constant (no DST).
  // 00:00:00 in Tashkent is 19:00:00 on (day - 1) in UTC.
  const startOfDay = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - (5 * 60 * 60 * 1000);
  const startOfNextDay = startOfDay + MS_PER_DAY;
  return { startOfDay, startOfNextDay };
}

/**
 * Format timestamp in Asia/Tashkent for display
 * @param {number|string} ts
 * @param {string} format 'time' | 'full'
 */
function formatTashkentTime(ts, format = 'time') {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (format === 'time') {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d);
  }
  return new Intl.DateTimeFormat('uz-UZ', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

/**
 * Fetch and compute single-day normalized report data
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {Promise<Object>} normalized reportData
 */
async function getReportForDate(dateStr) {
  const trimmed = (dateStr || '').trim();

  // 1. Validation: Format & Calendar existence
  if (!isValidDateString(trimmed)) {
    throw new Error(`INVALID_DATE_FORMAT: Sana noto'g'ri ko'rsatilgan (${dateStr}). Format: YYYY-MM-DD`);
  }

  // 2. Validation: Future date rejection
  const todayStr = getTashkentToday();
  if (trimmed > todayStr) {
    const err = new Error(`FUTURE_DATE: Kelajakdagi sana uchun hisobot mavjud emas. Bugungi sana: ${todayStr}`);
    err.todayStr = todayStr;
    throw err;
  }

  // 3. Compute half-open interval bounds in Asia/Tashkent
  const { startOfDay, startOfNextDay } = getTashkentDayBounds(trimmed);

  const client = await pool.connect();
  try {
    // 4. Query multi-item sales transactions
    const salesRes = await client.query(`
      SELECT 
        s.id,
        s.seller_id AS "sellerId",
        ROUND(COALESCE(s.subtotal, 0))::bigint AS subtotal,
        ROUND(COALESCE(s.discount, 0))::bigint AS discount,
        ROUND(COALESCE(s.total, 0))::bigint AS total,
        s.created_at::bigint AS "createdAt",
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
        ) AS items
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.created_at >= $1 
        AND s.created_at < $2 
        AND s.is_deleted = FALSE 
        AND s.status = 'COMPLETED'
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `, [startOfDay, startOfNextDay]);

    // 5. Query legacy activities with type = 'sale' that have NO sale_id (if any exist from earlier versions)
    const legacySalesRes = await client.query(`
      SELECT 
        id,
        timestamp::bigint AS timestamp,
        product_id AS "productId",
        product_name AS "productName",
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
    `, [startOfDay, startOfNextDay]);

    // 6. Query Chiqim (cash_out) expenses
    // Stores the monetary amount in quantity column, cast strictly to integer so'm
    const cashOutRes = await client.query(`
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
    `, [startOfDay, startOfNextDay]);

    // 7. Aggregate Totals strictly in integer units
    let grossSales = 0n;
    let manualDiscount = 0n;
    let itemsSold = 0;
    let transactionCount = salesRes.rows.length + legacySalesRes.rows.length;

    const aggregatedItemsMap = new Map();

    // Process multi-item sales
    for (const sale of salesRes.rows) {
      grossSales += BigInt(sale.subtotal);
      manualDiscount += BigInt(sale.discount);

      for (const it of sale.items) {
        itemsSold += Number(it.quantity || 0);
        const key = it.productId || it.productName;
        if (!aggregatedItemsMap.has(key)) {
          aggregatedItemsMap.set(key, {
            productId: it.productId,
            name: it.productName,
            quantity: 0,
            unitPrice: Number(it.salePrice || it.basePrice || 0),
            total: 0n
          });
        }
        const itemAgg = aggregatedItemsMap.get(key);
        itemAgg.quantity += Number(it.quantity || 0);
        itemAgg.total += BigInt(it.subtotal || 0);
      }
    }

    // Process legacy sales if any
    for (const leg of legacySalesRes.rows) {
      grossSales += BigInt(leg.subtotal);
      manualDiscount += BigInt(leg.discount);
      itemsSold += Number(leg.quantity || 0);

      const key = leg.productId || leg.productName;
      if (!aggregatedItemsMap.has(key)) {
        aggregatedItemsMap.set(key, {
          productId: leg.productId,
          name: leg.productName,
          quantity: 0,
          unitPrice: leg.quantity > 0 ? Math.round(Number(leg.subtotal) / leg.quantity) : 0,
          total: 0n
        });
      }
      const itemAgg = aggregatedItemsMap.get(key);
      itemAgg.quantity += Number(leg.quantity || 0);
      itemAgg.total += BigInt(leg.subtotal || 0);
    }

    const netSales = grossSales - manualDiscount;

    // Process Chiqim
    let totalChiqim = 0n;
    const cashOuts = cashOutRes.rows.map(r => {
      const amt = BigInt(r.amount);
      totalChiqim += amt;
      return {
        id: r.id,
        amount: Number(amt),
        reason: r.reason || 'Kassadan chiqim',
        notes: r.notes || null,
        timestamp: Number(r.timestamp),
        timeFormatted: formatTashkentTime(r.timestamp, 'time')
      };
    });

    // Net cash assumption: all sales currently cash transactions
    const netCash = netSales - totalChiqim;

    const items = Array.from(aggregatedItemsMap.values()).map(it => ({
      productId: it.productId,
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: Number(it.total)
    })).sort((a, b) => b.total - a.total);

    return {
      date: trimmed,
      timezone: TIMEZONE,
      totals: {
        grossSales: Number(grossSales),
        discount: Number(manualDiscount),
        netSales: Number(netSales),
        itemsSold,
        transactionCount,
        chiqim: Number(totalChiqim),
        netCash: Number(netCash)
      },
      items,
      cashOuts,
      sales: salesRes.rows.map(s => ({
        id: s.id,
        sellerId: s.sellerId,
        subtotal: Number(s.subtotal),
        discount: Number(s.discount),
        total: Number(s.total),
        createdAt: Number(s.createdAt),
        timeFormatted: formatTashkentTime(s.createdAt, 'time'),
        notes: s.notes,
        itemsCount: s.items.length,
        items: s.items
      }))
    };
  } finally {
    client.release();
  }
}

/**
 * Fetch 7-day daily summary rollup for Asia/Tashkent up to endDateStr
 * @param {string} [endDateStr] Optional end date (defaults to Tashkent today)
 * @returns {Promise<Object>} normalized 7-day reportData
 */
async function get7DayReport(endDateStr = null) {
  const targetEnd = (endDateStr && isValidDateString(endDateStr)) 
    ? endDateStr.trim() 
    : getTashkentToday();

  const [y, m, d] = targetEnd.split('-').map(Number);

  const days = [];
  // Build array of 7 consecutive calendar dates up to targetEnd in Tashkent
  for (let i = 6; i >= 0; i--) {
    const dObj = new Date(Date.UTC(y, m - 1, d - i, 12, 0, 0));
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    days.push(formatter.format(dObj));
  }

  const dailyReports = [];
  let rollupGross = 0;
  let rollupDiscount = 0;
  let rollupNetSales = 0;
  let rollupItemsSold = 0;
  let rollupTransactions = 0;
  let rollupChiqim = 0;
  let rollupNetCash = 0;

  for (const dateStr of days) {
    const report = await getReportForDate(dateStr);
    const [_, monthNum, dayNum] = dateStr.split('-');
    const monthsUz = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];
    const displayDate = `${dayNum} ${monthsUz[parseInt(monthNum, 10) - 1]}`;

    dailyReports.push({
      date: dateStr,
      displayDate,
      totals: report.totals
    });

    rollupGross += report.totals.grossSales;
    rollupDiscount += report.totals.discount;
    rollupNetSales += report.totals.netSales;
    rollupItemsSold += report.totals.itemsSold;
    rollupTransactions += report.totals.transactionCount;
    rollupChiqim += report.totals.chiqim;
    rollupNetCash += report.totals.netCash;
  }

  return {
    startDate: days[0],
    endDate: days[days.length - 1],
    timezone: TIMEZONE,
    dailyReports,
    rollup: {
      grossSales: rollupGross,
      discount: rollupDiscount,
      netSales: rollupNetSales,
      itemsSold: rollupItemsSold,
      transactionCount: rollupTransactions,
      chiqim: rollupChiqim,
      netCash: rollupNetCash
    }
  };
}

module.exports = {
  TIMEZONE,
  getTashkentToday,
  getTashkentYesterday,
  isValidDateString,
  getTashkentDayBounds,
  formatTashkentTime,
  getReportForDate,
  get7DayReport
};
