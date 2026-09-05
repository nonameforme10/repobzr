/**
 * SalesTrack — Firebase Cloud Functions
 *
 * Proxies the Central Bank of Uzbekistan currency endpoints so the
 * client-side dashboard can fetch them without CORS issues.
 *
 *   GET  /getCbuRates                    → today's full rates array
 *   GET  /getCbuHistory?ccy=USD&days=30  → last N days of one currency
 */

import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";

setGlobalOptions({maxInstances: 10});

const CBU_BASE = "https://cbu.uz/uz/arkhiv-kursov-valyut/json";

/**
 * Today's rates — returns the raw CBU array unchanged so the
 * frontend can parse `Ccy` / `Rate` exactly as documented.
 */
export const getCbuRates = onRequest(
  {cors: true, region: "us-central1", invoker: "public"},
  async (request, response) => {
    try {
      const cbuResponse = await fetch(`${CBU_BASE}/`);

      if (!cbuResponse.ok) {
        throw new Error(`CBU responded with ${cbuResponse.status}`);
      }

      const rawData = await cbuResponse.json();

      response.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
      response.status(200).send(rawData);
    } catch (error) {
      logger.error("Error fetching CBU rates", error);
      response.status(500).send({error: "Failed to fetch currency rates"});
    }
  },
);

/**
 * Historical rates for one currency.
 *   ?ccy=USD   (default USD; also supports EUR, RUB, etc.)
 *   ?days=30   (default 30, max 90)
 *
 * Returns: [{ date: "YYYY-MM-DD", rate: 12345.67 }, ...] ordered oldest→newest.
 */
export const getCbuHistory = onRequest(
  {cors: true, region: "us-central1", invoker: "public"},
  async (request, response) => {
    const ccy = String(request.query.ccy || "USD").toUpperCase();
    const requestedDays = parseInt(String(request.query.days || "30"), 10);
    const days = Math.min(Math.max(requestedDays || 30, 1), 90);

    try {
      const today = new Date();
      const dates: string[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }

      const fetchOne = async (date: string) => {
        try {
          const r = await fetch(`${CBU_BASE}/${ccy}/${date}/`);
          if (!r.ok) return null;
          const data = await r.json() as Array<Record<string, unknown>>;
          const row = Array.isArray(data) ? data[0] : null;
          if (!row || !row.Rate) return null;
          const rate = parseFloat(String(row.Rate));
          return Number.isFinite(rate) ? {date, rate} : null;
        } catch (err) {
          logger.warn("History fetch failed for", date, err);
          return null;
        }
      };

      const results = await Promise.all(dates.map(fetchOne));
      const filtered = results.filter((r): r is {date: string; rate: number} =>
        r !== null,
      );

      response.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
      response.status(200).send(filtered);
    } catch (error) {
      logger.error("Error fetching CBU history", error);
      response.status(500).send({error: "Failed to fetch history"});
    }
  },
);
