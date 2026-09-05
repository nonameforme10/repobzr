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
3. Provide concise, standard retail product titles in:
   - "uz": Uzbek (Latin alphabet, e.g. "Jinsi", "Qora choy", "Oq qand", "Futbolka")
   - "ru": Russian (e.g. "Джинсы", "Черный чай", "Белый сахар", "Футболка")
   - "en": English (e.g. "Jeans", "Black Tea", "White Sugar", "T-Shirt")

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
    return { provider: 'openrouter:gemini-2.5-flash', ...res };
  } catch (err1) {
    console.warn('[aiTranslationService] Tier 1 failed:', err1.message);
  }

  // Tier 2: Google AI Studio Direct (gemini-2.5-flash)
  try {
    const res = await callGoogleAIStudio(trimmed);
    return { provider: 'google:gemini-2.5-flash', ...res };
  } catch (err2) {
    console.warn('[aiTranslationService] Tier 2 failed:', err2.message);
  }

  // Tier 3: OpenRouter Free Backup (minimax/minimax-m3:free)
  try {
    const res = await callOpenRouter('minimax/minimax-m3:free', trimmed);
    return { provider: 'openrouter:minimax-m3:free', ...res };
  } catch (err3) {
    console.error('[aiTranslationService] Tier 3 failed:', err3.message);
    throw new Error('All AI translation providers failed: ' + err3.message);
  }
}

module.exports = {
  translateAndCheckProduct
};
