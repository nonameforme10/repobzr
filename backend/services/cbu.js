/**
 * Central Bank of Uzbekistan (CBU) Currency Service
 *
 * Provides resilient rates and history fetching with:
 * - In-memory caching with configurable TTL
 * - In-flight request deduplication (prevents thundering herd)
 * - Request timeouts via AbortController
 * - Safe stale-cache fallback upon upstream failures
 */

const CBU_BASE_URL = process.env.CBU_BASE_URL || 'https://cbu.uz/uz/arkhiv-kursov-valyut/json';
const RATES_CACHE_TTL_MS = parseInt(process.env.RATES_CACHE_TTL_MS || '3600000', 10); // 1 hour
const HISTORY_CACHE_TTL_MS = parseInt(process.env.HISTORY_CACHE_TTL_MS || '86400000', 10); // 24 hours
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '8000', 10); // 8 seconds

// In-memory cache structures
let ratesCache = {
  data: null,
  timestamp: 0
};

// Map of cacheKey -> { data, timestamp }
const historyCache = new Map();

// Map of in-flight promises to deduplicate simultaneous requests
const inFlight = new Map();

/**
 * Perform a fetch with a configurable timeout using AbortController.
 */
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SalesTrack-Backend/1.0'
      }
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new Error(`Upstream CBU request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Fetch today's exchange rates.
 * Returns { data, status: 'HIT' | 'MISS' | 'STALE' }
 */
async function getRates() {
  const now = Date.now();

  // 1. Fresh Cache HIT
  if (ratesCache.data && (now - ratesCache.timestamp < RATES_CACHE_TTL_MS)) {
    return { data: ratesCache.data, status: 'HIT' };
  }

  // 2. Reuse in-flight request if another caller is already fetching
  if (inFlight.has('rates')) {
    return await inFlight.get('rates');
  }

  // 3. Initiate fetch with deduplication
  const fetchPromise = (async () => {
    try {
      const res = await fetchWithTimeout(`${CBU_BASE_URL}/`);
      if (!res.ok) {
        throw new Error(`CBU upstream returned status ${res.status}`);
      }

      const json = await res.json();
      if (!Array.isArray(json) || json.length === 0) {
        throw new Error('CBU response is not a valid rates array');
      }

      // Valid response: update cache
      ratesCache = {
        data: json,
        timestamp: Date.now()
      };

      return { data: json, status: 'MISS' };
    } catch (err) {
      // 4. Stale-cache fallback if CBU fails and we have previous good data
      if (ratesCache.data) {
        console.warn(`[cbu-service] Rates fetch failed (${err.message}). Serving STALE cache.`);
        return { data: ratesCache.data, status: 'STALE' };
      }
      // No stale cache available; rethrow to controller
      throw err;
    } finally {
      inFlight.delete('rates');
    }
  })();

  inFlight.set('rates', fetchPromise);
  return await fetchPromise;
}

/**
 * Fetch historical rates for a single currency over N days.
 * @param {string} ccy - Currency code (e.g. USD, EUR, RUB)
 * @param {number|string} days - Number of days (1 to 90)
 * Returns { data: [{ date, rate }], status: 'HIT' | 'MISS' | 'STALE' }
 */
async function getHistory(ccy = 'USD', days = 30) {
  const sanitizedCcy = String(ccy || 'USD').trim().toUpperCase();
  const parsedDays = parseInt(String(days || '30'), 10);
  const sanitizedDays = Math.min(Math.max(Number.isFinite(parsedDays) ? parsedDays : 30, 1), 90);

  const cacheKey = `${sanitizedCcy}_${sanitizedDays}`;
  const now = Date.now();

  // 1. Fresh Cache HIT
  const cached = historyCache.get(cacheKey);
  if (cached && (now - cached.timestamp < HISTORY_CACHE_TTL_MS)) {
    return { data: cached.data, status: 'HIT' };
  }

  // 2. Reuse in-flight request
  if (inFlight.has(cacheKey)) {
    return await inFlight.get(cacheKey);
  }

  // 3. Initiate fetch
  const fetchPromise = (async () => {
    try {
      const today = new Date();
      const dates = [];
      for (let i = sanitizedDays - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }

      const fetchSingleDay = async (date) => {
        try {
          const res = await fetchWithTimeout(`${CBU_BASE_URL}/${sanitizedCcy}/${date}/`);
          if (!res.ok) return null;
          const data = await res.json();
          const row = Array.isArray(data) ? data[0] : null;
          if (!row || !row.Rate) return null;
          const rate = parseFloat(String(row.Rate));
          return Number.isFinite(rate) ? { date, rate } : null;
        } catch (err) {
          return null;
        }
      };

      const results = await Promise.all(dates.map(fetchSingleDay));
      const filtered = results.filter((item) => item !== null);

      if (filtered.length === 0) {
        throw new Error(`Failed to fetch history points for ${sanitizedCcy}`);
      }

      historyCache.set(cacheKey, {
        data: filtered,
        timestamp: Date.now()
      });

      return { data: filtered, status: 'MISS' };
    } catch (err) {
      // 4. Stale-cache fallback
      if (cached && cached.data) {
        console.warn(`[cbu-service] History fetch failed for ${cacheKey} (${err.message}). Serving STALE cache.`);
        return { data: cached.data, status: 'STALE' };
      }
      throw err;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, fetchPromise);
  return await fetchPromise;
}

module.exports = {
  getRates,
  getHistory
};
