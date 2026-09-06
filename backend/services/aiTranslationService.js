/**
 * SalesTrack — AI Multilingual Product Translation & Typo Correction Service
 *
 * Tier 1: OpenRouter (google/gemini-2.5-flash) — Ultra-fast (1.1s) & Smartest
 * Tier 2: Google AI Studio (gemini-2.5-flash) — Direct Google API
 * Tier 3: OpenRouter (minimax/minimax-m3:free) — 100% Free Backup Fallback
 */

const https = require('https');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY5 || process.env.OPENROUTER_API_KEY || '';
const AI_STUDIO_API_KEY = process.env.AI_STUDIO_API_KEY1 || process.env.GEMINI_API_KEY || '';

const SYSTEM_PROMPT = `You are a retail product catalog translation and spelling correction engine for Uzbekistan retail stores.
Your task is to take an input product name (which may be in Uzbek Latin/Cyrillic, Russian, or English, and may have typos, slang, or transliteration errors) and:
1. Identify any typos or inappropriate slips (for example: "Jinsiy" in a clothing store is a typo for "Jinsi" (Jeans)).
2. Correct the typo if found.
3. Provide concise, standard, professional retail product titles in:
   - "uz": Uzbek (Latin alphabet, standard retail terminology)
   - "ru": Russian (natural retail product title, always including the noun, e.g. "Джинсовая куртка", never just an adjective like "Джинсовый")
   - "en": English (natural, idiomatic retail e-commerce titles, Title Cased, as used by major fashion and retail brands)

CRITICAL RETAIL TERMINOLOGY RULES:
- DENIM & CLOTHING IN UZBEKISTAN:
  * "Jinsi kostyum", "jinsi kurtka", "jinsi pidjak", "джинсовка", "джинсовая куртка" refer to a DENIM JACKET (Jean Jacket), NOT a "denim suit"! In English, NEVER output "Denim Suit" for a denim jacket or top outerwear. Translate to English as "Denim Jacket" (or "Jean Jacket").
  * If the item is explicitly a matching 2-piece set of jacket/top + pants (e.g. "jinsi dvoyka", "jinsi komplekt", "jinsi kostyum shim"), translate to English as "Denim Set" or "Two-Piece Denim Set", NEVER "Denim Suit".
  * "Jinsi" / "Jinsi shim" / "Джинсы" -> uz: "Jinsi shim" or "Jinsi", ru: "Джинсы", en: "Jeans".
  * "Jinsi nimcha" / "Джинсовый жилет" -> en: "Denim Vest".
  * "Jinsi yubka" -> en: "Denim Skirt".
  * "Jinsi shortik" / "Jinsi shorti" -> en: "Denim Shorts".
  * "Jinsi kombinezon" -> en: "Denim Overalls" or "Denim Jumpsuit".
- SUITS, SETS & SPORTSWEAR:
  * "Sportivny kostyum" / "Sportivka" / "Sport kostyumi" -> en: "Tracksuit" or "Sweatsuit" (NEVER "Sport Suit").
  * "Dvoyka" / "Kostyum dvoyka" -> en: "Two-Piece Set" (or "Two-Piece Suit" if formal business suit).
  * "Troyka" / "Kostyum troyka" -> en: "Three-Piece Set" (or "Three-Piece Suit" if formal business suit, NEVER "Troika").
  * "Kostyum" (alone) -> if formal suit: en: "Suit" (uz: "Kostyum", ru: "Костюм").
  * "Kostyum-shim" -> en: "Trouser Suit" or "Two-Piece Suit" (ru: "Брючный костюм").
  * "Klassik kostyum" -> en: "Classic Suit" (ru: "Классический костюм").
  * "Tolstovka" / "Xudi" -> en: "Hoodie" or "Sweatshirt".
  * "Vetrovka" -> en: "Windbreaker".
  * "Kofta" -> en: "Cardigan" or "Sweater".
  * "Vodolazka" / "Golf" -> en: "Turtleneck".
  * "Losina" / "Legginsy" -> en: "Leggings".
  * "Tapochka" -> en: "Slippers" or "Slides".
  * "Krossovka" -> en: "Sneakers".
- GENERAL RULES:
  * Russian titles must be complete noun phrases (e.g. "Джинсовая куртка", "Черная футболка"), NEVER solitary adjectives (never output "Джинсовый" alone).
  * English titles must sound natural in e-commerce catalogs (Title Case). Never use awkward literal word-for-word translations.

You MUST return ONLY a strict JSON object with NO markdown formatting, matching this exact schema:
{
  "original": "<input name>",
  "corrected": "<corrected name in input language>",
  "hasTypo": true/false,
  "typoExplanation": "<brief explanation if typo, or empty string>",
  "translations": {
    "uz": "<Uzbek Latin product name>",
    "ru": "<Russian product name>",
    "en": "<English product name>"
  }
}`;

function cleanJsonResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  return JSON.parse(cleaned);
}

/**
 * Deterministic post-processing to eliminate retail translation blunders like "Denim Suit"
 */
function sanitizeTranslations(result, originalInput) {
  if (!result || !result.translations) return result;

  const t = result.translations;
  const inputLower = (originalInput || '').toLowerCase();

  // 1. Sanitize English translation
  if (typeof t.en === 'string') {
    let en = t.en.trim();

    // Prevent "Denim Suit" / "denim suit"
    if (/\bdenim suit\b/i.test(en)) {
      const isExplicitSet = /\b(set|dvoyka|dvojka|komplekt|shim|pants|trousers|two-piece|2-piece)\b/i.test(inputLower);
      if (isExplicitSet) {
        en = en.replace(/\bdenim suit\b/gi, 'Denim Set');
      } else {
        en = en.replace(/\bdenim suit\b/gi, 'Denim Jacket');
      }
    }

    // Prevent "Sport Suit" -> "Tracksuit"
    if (/\bsport suit\b/i.test(en)) {
      en = en.replace(/\bsport suit\b/gi, 'Tracksuit');
    }

    // Prevent "Troika" -> "Three-Piece Set"
    if (/^troika$/i.test(en.trim())) {
      en = 'Three-Piece Set';
    }

    t.en = en;
  }

  // 2. Sanitize Russian translation
  if (typeof t.ru === 'string') {
    let ru = t.ru.trim();

    // Prevent naked solitary adjectives
    if (/^джинсовый$/i.test(ru)) {
      ru = 'Джинсовая куртка';
    } else if (/^спортивный$/i.test(ru)) {
      ru = 'Спортивный костюм';
    }

    t.ru = ru;
  }

  // 3. Sanitize Uzbek translation
  if (typeof t.uz === 'string') {
    let uz = t.uz.trim();
    if (/^jinsi$/i.test(uz) && /\b(kostyum|kurtka|pidjak)\b/i.test(inputLower)) {
      uz = 'Jinsi kurtka';
    }
    t.uz = uz;
  }

  return result;
}

/**
 * Call OpenRouter API
 */
function callOpenRouter(modelName, productName) {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_API_KEY) return reject(new Error('OPENROUTER_API_KEY missing'));

    const payload = JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Product Name: "${productName}"` }
      ],
      max_tokens: 400,
      temperature: 0.1
    });

    const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://admin.caretrack.website',
        'X-Title': 'Bazar Merchant Suite'
      },
      timeout: 7000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`OpenRouter (${modelName}) returned ${res.statusCode}: ${data.slice(0, 150)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content;
          const result = cleanJsonResponse(content);
          if (!result || !result.translations) throw new Error('Invalid JSON structure');
          resolve(result);
        } catch (e) {
          reject(new Error(`OpenRouter (${modelName}) parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Call Google AI Studio Direct API (gemini-2.5-flash)
 */
function callGoogleAIStudio(productName) {
  return new Promise((resolve, reject) => {
    if (!AI_STUDIO_API_KEY) return reject(new Error('AI_STUDIO_API_KEY missing'));

    const payload = JSON.stringify({
      contents: [{
        parts: [{
          text: `${SYSTEM_PROMPT}\n\nProduct Name: "${productName}"`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(AI_STUDIO_API_KEY)}`;
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 7000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Google AI Studio returned ${res.statusCode}: ${data.slice(0, 150)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          const result = cleanJsonResponse(content);
          if (!result || !result.translations) throw new Error('Invalid JSON structure');
          resolve(result);
        } catch (e) {
          reject(new Error(`Google AI Studio parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Google AI Studio timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Translate and spell-check product name with 3-tier resilient failover
 */
async function translateAndCheckProduct(productName) {
  const trimmed = (typeof productName === 'string') ? productName.trim() : '';
  if (!trimmed) {
    throw new Error('Product name is required');
  }

  // Tier 1: OpenRouter (google/gemini-2.5-flash) — fastest & smartest
  try {
    const res = await callOpenRouter('google/gemini-2.5-flash', trimmed);
    const sanitized = sanitizeTranslations(res, trimmed);
    return { provider: 'openrouter:gemini-2.5-flash', ...sanitized };
  } catch (err1) {
    console.warn('[aiTranslationService] Tier 1 failed:', err1.message);
  }

  // Tier 2: Google AI Studio Direct (gemini-2.5-flash)
  try {
    const res = await callGoogleAIStudio(trimmed);
    const sanitized = sanitizeTranslations(res, trimmed);
    return { provider: 'google:gemini-2.5-flash', ...sanitized };
  } catch (err2) {
    console.warn('[aiTranslationService] Tier 2 failed:', err2.message);
  }

  // Tier 3: OpenRouter Free Backup (minimax/minimax-m3:free)
  try {
    const res = await callOpenRouter('minimax/minimax-m3:free', trimmed);
    const sanitized = sanitizeTranslations(res, trimmed);
    return { provider: 'openrouter:minimax-m3:free', ...sanitized };
  } catch (err3) {
    console.error('[aiTranslationService] Tier 3 failed:', err3.message);
    throw new Error('All AI translation providers failed: ' + err3.message);
  }
}

module.exports = {
  translateAndCheckProduct
};
