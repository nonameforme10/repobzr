/* ============================================
   DAILY SALES COUNTER DASHBOARD
   Vanilla JavaScript - Single Page Application
   ============================================ */

// ==================== CONFIG & STATE ====================
const STORAGE_KEY = 'salesDashboard_v1';

// Base currency for stored prices — the dashboard stores everything in UZS
// and converts at display time using rates fetched from the CBU proxy.
const BASE_CURRENCY = 'UZS';

// === BACKEND API CONFIGURATION ==============================================
// Canonical backend path is '/api' (proxied by Vercel rewrites to your VPS HTTPS endpoint).
// Can be overridden via window.SALESTRACK_API_URL if connecting directly.
const API_BASE_URL    = (typeof window !== 'undefined' && window.SALESTRACK_API_URL) || '/api';
const CBU_PROXY_URL   = `${API_BASE_URL}/rates`;
const CBU_HISTORY_URL = `${API_BASE_URL}/history`;

let state = {
    categories: [],
    products: [],
    activities: [],
    settings: {
        lastResetDate: null,
        currency: BASE_CURRENCY
    }
};

let chartInstances = {};
let currentPage = 'dashboard';

// ==================== CURRENCY (CBU rates via proxy) ====================
const CURRENCY_STORAGE_KEY = 'salestrack-currency';
const CURRENCY_RATES_KEY   = 'salestrack-rates';
const CURRENCY_TTL_MS      = 6 * 60 * 60 * 1000; // 6 hours

const currency = (() => {
    const SUPPORTED = ['UZS', 'USD', 'EUR'];
    const SYMBOLS   = { UZS: 'soʻm', USD: '$', EUR: '€' };

    // Rates are stored as "UZS per 1 unit of <code>"; UZS is the base, so 1.
    let rates     = { UZS: 1, USD: null, EUR: null };
    let updatedAt = null;
    let active    = BASE_CURRENCY;
    let fetching  = false;

    function load() {
        try {
            const code = localStorage.getItem(CURRENCY_STORAGE_KEY);
            if (code && SUPPORTED.includes(code)) active = code;
            const cached = localStorage.getItem(CURRENCY_RATES_KEY);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.rates) {
                    rates = { UZS: 1, USD: parsed.rates.USD || null, EUR: parsed.rates.EUR || null };
                    updatedAt = parsed.updatedAt || null;
                }
            }
        } catch (e) { /* storage may be blocked */ }
    }

    function persistRates() {
        try {
            localStorage.setItem(CURRENCY_RATES_KEY, JSON.stringify({ rates, updatedAt }));
        } catch (e) {}
    }

    function isStale() {
        if (!updatedAt) return true;
        return (Date.now() - updatedAt) > CURRENCY_TTL_MS;
    }

    function isProxyConfigured() {
        return typeof API_BASE_URL === 'string' && API_BASE_URL.trim().length > 0;
    }

    async function fetchRates(force = false) {
        if (!isProxyConfigured() || fetching) return null;
        if (!force && !isStale() && rates.USD && rates.EUR) return rates;
        fetching = true;
        try {
            const res = await fetch(CBU_PROXY_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

            // Accept both raw CBU passthrough (array) and any object wrapper { rates: [...] }
            const arr = Array.isArray(data)
                ? data
                : (data && Array.isArray(data.rates) ? data.rates : null);
            if (!arr) throw new Error('Unexpected response shape from proxy');

            const pick = (ccy) => {
                const row = arr.find(c => String(c.Ccy || c.code || '').toUpperCase() === ccy);
                if (!row) return null;
                const v = parseFloat(row.Rate ?? row.rate);
                return isFinite(v) && v > 0 ? v : null;
            };
            const usd = pick('USD');
            const eur = pick('EUR');
            if (usd) rates.USD = usd;
            if (eur) rates.EUR = eur;
            updatedAt = Date.now();
            persistRates();
            document.dispatchEvent(new CustomEvent('currency:rates', { detail: { rates, updatedAt } }));
            return rates;
        } catch (e) {
            console.warn('[currency] CBU rates fetch failed:', e);
            return null;
        } finally {
            fetching = false;
        }
    }

    function getActive() { return active; }

    function setActive(code) {
        if (!SUPPORTED.includes(code)) return false;
        if (code === active) return true;
        active = code;
        try { localStorage.setItem(CURRENCY_STORAGE_KEY, code); } catch (e) {}
        document.dispatchEvent(new CustomEvent('currency:change', { detail: { code } }));
        return true;
    }

    function getRate(code)    { return rates[code] || null; }
    function getRates()       { return { ...rates }; }
    function getUpdatedAt()   { return updatedAt; }
    function hasRates()       { return !!(rates.USD && rates.EUR); }

    return {
        SUPPORTED, SYMBOLS, BASE: BASE_CURRENCY,
        load, fetchRates, isProxyConfigured, hasRates, isStale,
        getActive, setActive,
        getRate, getRates, getUpdatedAt
    };
})();

// ==================== LOCAL-FIRST INDEXEDDB & SYNC ENGINE ====================
const DB_NAME = 'SalesTrackDB';
const DB_VERSION = 1;

const localDb = {
    db: null,
    async init() {
        return new Promise((resolve, reject) => {
            if (this.db) return resolve(this.db);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('activities')) db.createObjectStore('activities', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
                if (!db.objectStoreNames.contains('outbox')) {
                    const outboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
                    outboxStore.createIndex('status', 'status', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = (e) => {
                console.error('[idb] Failed to open IndexedDB:', e.target.error);
                resolve(null); // fallback gracefully if storage restricted
            };
        });
    },

    async getAll(storeName) {
        if (!this.db) return [];
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } catch (e) { resolve([]); }
        });
    },

    async put(storeName, value) {
        if (!this.db) return;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.put(value);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    },

    async putAll(storeName, items) {
        if (!this.db || !Array.isArray(items)) return;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                for (const item of items) {
                    store.put(item);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    },

    async delete(storeName, key) {
        if (!this.db) return;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    },

    async clear(storeName) {
        if (!this.db) return;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) { resolve(); }
        });
    },

    async getMeta(key) {
        if (!this.db) return null;
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('meta', 'readonly');
                const store = tx.objectStore('meta');
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result ? req.result.value : null);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    },

    async setMeta(key, value) {
        if (!this.db) return;
        return this.put('meta', { key, value });
    }
};

function getDeviceId() {
    let devId = null;
    try {
        devId = localStorage.getItem('salestrack_device_id');
    } catch (e) {}

    if (!devId) {
        devId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
        try {
            localStorage.setItem('salestrack_device_id', devId);
        } catch (e) {}
    }
    return devId;
}

async function enqueueOperation(type, payload) {
    const op = {
        id: 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9),
        deviceId: getDeviceId(),
        type,
        payload,
        createdAt: Date.now(),
        status: 'pending',
        attempts: 0
    };

    await localDb.put('outbox', op);
    if (typeof syncEngine !== 'undefined' && syncEngine.kick) {
        syncEngine.kick();
    }
    return op;
}

const syncEngine = {
    isOnline: navigator.onLine,
    syncing: false,
    retryTimer: null,
    attempts: 0,

    async updateUI() {
        const pill = document.getElementById('syncStatusPill');
        const label = document.getElementById('syncStatusLabel');
        if (!pill || !label) return;

        const allOps = await localDb.getAll('outbox');
        const pending = allOps.filter(o => o.status === 'pending' || o.status === 'syncing');
        const failed = allOps.filter(o => o.status === 'failed' || o.status === 'conflict');

        pill.className = 'sync-pill';

        if (failed.length > 0) {
            pill.classList.add('sync-alert');
            label.textContent = `⚠️ ${failed.length} sync issue${failed.length > 1 ? 's' : ''}`;
            pill.title = failed.map(f => `${f.type}: ${f.errorMessage || f.errorCode}`).join('\n');
        } else if (!this.isOnline) {
            pill.classList.add('offline');
            label.textContent = pending.length > 0
                ? `🔴 Offline (${pending.length} saved locally)`
                : '🔴 Offline';
            pill.title = 'Offline — actions are safely saved in local database';
        } else if (this.syncing || pending.length > 0) {
            pill.classList.add('syncing');
            label.textContent = `🟡 Syncing (${pending.length} pending)...`;
            pill.title = 'Synchronizing changes with company database...';
        } else {
            pill.classList.add('online-synced');
            label.textContent = '🟢 Synced';
            pill.title = 'Online — All changes synchronized with company database';
        }
    },

    async probeConnectivity() {
        if (!navigator.onLine) {
            this.isOnline = false;
            return false;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(`${API_BASE_URL}/health`, {
                cache: 'no-store',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            this.isOnline = res.ok;
            return res.ok;
        } catch (e) {
            this.isOnline = false;
            return false;
        }
    },

    async kick() {
        if (this.syncing) return;
        clearTimeout(this.retryTimer);
        this.syncing = true;
        await this.updateUI();

        try {
            const reachable = await this.probeConnectivity();
            if (!reachable) {
                this.syncing = false;
                await this.updateUI();
                this.scheduleRetry();
                return;
            }

            await this.pushOutbox();
            await this.pullChanges();
            this.attempts = 0;
        } catch (err) {
            console.warn('[sync] Cycle encountered an issue:', err);
            this.scheduleRetry();
        } finally {
            this.syncing = false;
            await this.updateUI();
        }
    },

    async pushOutbox() {
        const allOps = await localDb.getAll('outbox');
        const pending = allOps.filter(o => o.status === 'pending');
        if (pending.length === 0) return;

        const batch = pending.slice(0, 50);
        for (const op of batch) {
            op.status = 'syncing';
            await localDb.put('outbox', op);
        }
        await this.updateUI();

        const res = await fetch(`${API_BASE_URL}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: getDeviceId(),
                operations: batch
            })
        });

        if (!res.ok) {
            throw new Error(`Sync HTTP error ${res.status}`);
        }

        const data = await res.json();
        const accepted = new Set(data.accepted || []);
        const rejectedMap = new Map((data.rejected || []).map(r => [r.id, r]));

        for (const op of batch) {
            if (accepted.has(op.id)) {
                await localDb.delete('outbox', op.id);
            } else if (rejectedMap.has(op.id)) {
                const rej = rejectedMap.get(op.id);
                op.status = 'failed';
                op.errorCode = rej.code || 'REJECTED';
                op.errorMessage = rej.message || 'Operation rejected by server';
                op.attempts = (op.attempts || 0) + 1;
                await localDb.put('outbox', op);
                showToast(`⚠️ Sync notice: ${op.errorMessage}`, 'warning');
            } else {
                op.status = 'pending';
                await localDb.put('outbox', op);
            }
        }
    },

    async pullChanges() {
        const lastSyncSeq = (await localDb.getMeta('lastSyncSeq')) || 0;
        const res = await fetch(`${API_BASE_URL}/sync?since=${lastSyncSeq}`, { cache: 'no-store' });
        if (!res.ok) return;

        const data = await res.json();

        if (data.requiresBootstrap) {
            const snapRes = await fetch(`${API_BASE_URL}/data`, { cache: 'no-store' });
            if (snapRes.ok) {
                const snap = await snapRes.json();
                await this.mergeSnapshot(snap);
                await localDb.setMeta('lastSyncSeq', snap.currentSeq || 0);
            }
            return;
        }

        if (Array.isArray(data.changes) && data.changes.length > 0) {
            await this.applyDeltaChanges(data.changes);
            await localDb.setMeta('lastSyncSeq', data.currentSeq || 0);
        }
    },

    async applyDeltaChanges(changes) {
        const allOps = await localDb.getAll('outbox');
        const pendingEntityIds = new Set(
            allOps.filter(o => o.status === 'pending' || o.status === 'syncing')
                .map(o => o.payload?.productId || o.payload?.id)
                .filter(Boolean)
        );

        let modified = false;
        for (const ch of changes) {
            if (ch.entityType === 'product') {
                if (pendingEntityIds.has(ch.entityId)) continue; // conflict protection
                const prod = ch.data;
                const idx = state.products.findIndex(p => p.id === ch.entityId);
                if (ch.action === 'DELETE') {
                    if (idx !== -1) { state.products.splice(idx, 1); modified = true; }
                    await localDb.delete('products', ch.entityId);
                } else if (idx !== -1) {
                    state.products[idx] = { ...state.products[idx], ...prod };
                    await localDb.put('products', state.products[idx]);
                    modified = true;
                } else {
                    state.products.push(prod);
                    await localDb.put('products', prod);
                    modified = true;
                }
            } else if (ch.entityType === 'category') {
                const cat = ch.data;
                const idx = state.categories.findIndex(c => c.id === ch.entityId);
                if (ch.action === 'DELETE') {
                    if (idx !== -1) { state.categories.splice(idx, 1); modified = true; }
                    await localDb.delete('categories', ch.entityId);
                } else if (idx !== -1) {
                    state.categories[idx] = { ...state.categories[idx], ...cat };
                    await localDb.put('categories', state.categories[idx]);
                    modified = true;
                } else {
                    state.categories.push(cat);
                    await localDb.put('categories', cat);
                    modified = true;
                }
            } else if (ch.entityType === 'activity') {
                const act = ch.data;
                if (!state.activities.some(a => a.id === act.id)) {
                    state.activities.unshift(act);
                    await localDb.put('activities', act);
                    modified = true;
                }
            }
        }

        if (modified) {
            refreshAll();
        }
    },

    async mergeSnapshot(snapshot) {
        const allOps = await localDb.getAll('outbox');
        const pendingEntityIds = new Set(
            allOps.filter(o => o.status === 'pending' || o.status === 'syncing')
                .map(o => o.payload?.productId || o.payload?.id)
                .filter(Boolean)
        );

        if (Array.isArray(snapshot.categories)) {
            state.categories = snapshot.categories;
            await localDb.putAll('categories', state.categories);
        }

        if (Array.isArray(snapshot.products)) {
            const merged = snapshot.products.map(sp => {
                if (pendingEntityIds.has(sp.id)) {
                    return state.products.find(p => p.id === sp.id) || sp;
                }
                return sp;
            });
            state.products = merged;
            await localDb.putAll('products', state.products);
        }

        if (Array.isArray(snapshot.activities)) {
            state.activities = snapshot.activities;
            await localDb.putAll('activities', state.activities);
        }

        refreshAll();
    },

    scheduleRetry() {
        clearTimeout(this.retryTimer);
        this.attempts++;
        const base = Math.min(60000, 1000 * Math.pow(1.8, Math.min(this.attempts, 7)));
        const jitter = Math.floor(Math.random() * 1500);
        this.retryTimer = setTimeout(() => this.kick(), base + jitter);
    }
};

// ==================== STORAGE ====================
async function loadState() {
    try {
        const [cats, prods, acts, sets] = await Promise.all([
            localDb.getAll('categories'),
            localDb.getAll('products'),
            localDb.getAll('activities'),
            localDb.getAll('settings')
        ]);

        if (cats.length > 0 || prods.length > 0) {
            state.categories = cats;
            state.products = prods;
            state.activities = acts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            if (sets.length > 0) {
                const settingsObj = {};
                sets.forEach(s => settingsObj[s.key] = s.value);
                state.settings = { ...state.settings, ...settingsObj };
            }
        } else {
            // One-time legacy migration from localStorage
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed.categories || parsed.products) {
                    state = { ...state, ...parsed };
                    await saveState();
                }
            }
        }
    } catch (e) {
        console.error('Failed to load state from IndexedDB:', e);
    }
}

async function saveState() {
    try {
        // Fallback snapshot in localStorage
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}

        // Durable persistence in IndexedDB local replica
        await Promise.all([
            localDb.putAll('categories', state.categories),
            localDb.putAll('products', state.products),
            localDb.putAll('activities', state.activities.slice(0, 500))
        ]);
    } catch (e) {
        console.error('Failed to save state to IndexedDB:', e);
    }
    syncEngine.updateUI();
}

function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-backup-${formatDateFile(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(tr('data.exported'), 'success');
}

function importData(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.categories && data.products && data.activities) {
                state = { ...state, ...data };
                saveState();
                refreshAll();
                showToast(tr('data.imported'), 'success');
            } else {
                showToast(tr('data.invalidFile'), 'error');
            }
        } catch (err) {
            showToast(tr('data.importFailed'), 'error');
        }
    };
    reader.readAsText(file);
}

// ==================== UTILITIES ====================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
    const d = new Date(ts);
    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : undefined;
    return d.toLocaleDateString(lang, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateFile(d) {
    return d.toISOString().split('T')[0];
}

function formatDateTime(ts) {
    return `${formatDate(ts)} ${formatTime(ts)}`;
}

function formatCurrency(amountUZS) {
    if (amountUZS === null || amountUZS === undefined || isNaN(amountUZS)) return '-';
    const code = currency.getActive();
    let converted = parseFloat(amountUZS);
    let displayCode = code;

    if (code !== BASE_CURRENCY) {
        const rate = currency.getRate(code);
        if (rate && rate > 0) {
            converted = converted / rate;
        } else {
            // Rates not available yet — fall back to base so we don't show a wrong number.
            displayCode = BASE_CURRENCY;
        }
    }

    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : undefined;
    const fractionDigits = displayCode === 'UZS' ? 0 : 2;
    try {
        return new Intl.NumberFormat(lang, {
            style: 'currency',
            currency: displayCode,
            maximumFractionDigits: fractionDigits,
            minimumFractionDigits: fractionDigits
        }).format(converted);
    } catch (e) {
        const symbol = currency.SYMBOLS[displayCode] || displayCode;
        return `${symbol} ${converted.toFixed(fractionDigits)}`;
    }
}

function getTodayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function getResetTime() {
    return state.settings.lastResetDate || getTodayStart();
}

function isAfterReset(ts) {
    return ts >= getResetTime();
}

function getCategory(id) {
    return state.categories.find(c => c.id === id);
}

function getProduct(id) {
    return state.products.find(p => p.id === id);
}

function getCategoryName(id) {
    const c = getCategory(id);
    return c ? c.name : 'Unknown';
}

function getProductName(id) {
    const p = getProduct(id);
    return p ? p.name : 'Unknown';
}

function getProductsByCategory(catId) {
    return state.products.filter(p => p.categoryId === catId);
}

function getSoldToday(productId = null) {
    const resetTime = getResetTime();
    let activities = state.activities.filter(a => a.type === 'sale' && a.timestamp >= resetTime);
    if (productId) {
        activities = activities.filter(a => a.productId === productId);
    }
    return activities.reduce((sum, a) => sum + (a.quantity || 0), 0);
}

function getRevenue(productId = null) {
    const prods = productId ? [getProduct(productId)].filter(Boolean) : state.products;
    return prods.reduce((sum, p) => sum + ((p.price || 0) * p.sold), 0);
}

function getTodayRevenue() {
    const resetTime = getResetTime();
    return state.activities
        .filter(a => a.type === 'sale' && a.timestamp >= resetTime)
        .reduce((sum, a) => {
            const p = getProduct(a.productId);
            return sum + ((p && p.price ? p.price * a.quantity : 0));
        }, 0);
}

function getCategoryStats() {
    return state.categories.map(c => {
        const prods = getProductsByCategory(c.id);
        const sold = prods.reduce((s, p) => s + p.sold, 0);
        const revenue = prods.reduce((s, p) => s + ((p.price || 0) * p.sold), 0);
        return { ...c, productCount: prods.length, sold, revenue };
    });
}

// ==================== I18N HELPER ====================
function tr(key, params) {
    return (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, params) : key;
}

// ==================== TOASTS & CONFIRM ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function confirmAction(title, message, onConfirm) {
    const overlay = document.getElementById('confirmOverlay');
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');

    titleEl.textContent = title;
    msgEl.textContent = message;
    overlay.classList.add('open');

    const cleanup = () => {
        overlay.classList.remove('open');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
    };

    okBtn.onclick = () => { cleanup(); onConfirm(); };
    cancelBtn.onclick = cleanup;
}

// ==================== MODAL SYSTEM ====================
function openModal(title, bodyHtml, footerHtml = '') {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
});

// ==================== ACTIVITY LOG ====================
function addActivity(data) {
    const activity = {
        id: generateId(),
        timestamp: Date.now(),
        ...data
    };
    state.activities.unshift(activity);
    saveState();
    return activity;
}

function deleteActivity(id) {
    state.activities = state.activities.filter(a => a.id !== id);
    saveState();
    renderActivity();
    renderDashboard();
}

function editActivityNotes(id, newNotes) {
    const act = state.activities.find(a => a.id === id);
    if (act) {
        act.notes = newNotes;
        act.editedAt = Date.now();
        saveState();
        renderActivity();
        renderDashboard();
        showToast(tr('activity.noteUpdated'), 'success');
    }
}

// ==================== CATEGORY CRUD ====================
function addCategory(name) {
    if (!name.trim()) return showToast(tr('category.nameRequired'), 'error');
    if (state.categories.some(c => c.name.toLowerCase() === name.trim().toLowerCase())) {
        return showToast(tr('category.duplicate'), 'warning');
    }
    const cat = { id: generateId(), name: name.trim(), createdAt: Date.now() };
    state.categories.push(cat);
    saveState();
    enqueueOperation('CREATE_CATEGORY', { id: cat.id, name: cat.name, createdAt: cat.createdAt });
    addActivity({ type: 'create', categoryId: cat.id, categoryName: cat.name, notes: 'Category created' });
    showToast(tr('category.created'), 'success');
    refreshAll();
    closeModal();
}

function updateCategory(id, name) {
    const cat = getCategory(id);
    if (!cat) return;
    if (!name.trim()) return showToast(tr('category.nameRequired'), 'error');
    const oldName = cat.name;
    cat.name = name.trim();
    saveState();
    enqueueOperation('UPDATE_CATEGORY', { id, name: cat.name });
    addActivity({ type: 'update', categoryId: id, categoryName: cat.name, notes: `Renamed from "${oldName}"` });
    showToast(tr('category.updated'), 'success');
    refreshAll();
    closeModal();
}

function deleteCategory(id) {
    confirmAction(tr('category.delete'), tr('category.confirmDelete'), () => {
        const cat = getCategory(id);
        const prods = getProductsByCategory(id);
        state.products = state.products.filter(p => p.categoryId !== id);
        state.categories = state.categories.filter(c => c.id !== id);
        saveState();
        enqueueOperation('DELETE_CATEGORY', { id });
        addActivity({ type: 'delete', categoryId: id, categoryName: cat ? cat.name : 'Unknown', notes: `Deleted ${prods.length} products` });
        showToast(tr('category.deleted'), 'success');
        refreshAll();
    });
}

// ==================== PRODUCT CRUD ====================
function addProduct(data) {
    if (!data.name.trim()) return showToast(tr('product.nameRequired'), 'error');
    if (!data.categoryId) return showToast(tr('product.categoryRequired'), 'error');
    const prod = {
        id: generateId(),
        name: data.name.trim(),
        categoryId: data.categoryId,
        quantity: parseInt(data.quantity) || 0,
        sold: 0,
        price: data.price ? parseFloat(data.price) : null,
        notes: data.notes || '',
        createdAt: Date.now()
    };
    state.products.push(prod);
    saveState();
    enqueueOperation('CREATE_PRODUCT', {
        id: prod.id,
        categoryId: prod.categoryId,
        name: prod.name,
        quantity: prod.quantity,
        sold: prod.sold,
        price: prod.price,
        notes: prod.notes,
        createdAt: prod.createdAt
    });
    addActivity({
        type: 'create',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId,
        categoryName: getCategoryName(prod.categoryId),
        notes: 'Product created'
    });
    showToast(tr('product.added'), 'success');
    refreshAll();
    closeModal();
}

function updateProduct(id, data) {
    const prod = getProduct(id);
    if (!prod) return;
    if (!data.name.trim()) return showToast(tr('product.nameRequired'), 'error');
    prod.name = data.name.trim();
    prod.categoryId = data.categoryId;
    prod.quantity = parseInt(data.quantity) || 0;
    prod.price = data.price ? parseFloat(data.price) : null;
    prod.notes = data.notes || '';
    saveState();
    enqueueOperation('UPDATE_PRODUCT', {
        id,
        categoryId: prod.categoryId,
        name: prod.name,
        quantity: prod.quantity,
        sold: prod.sold,
        price: prod.price,
        notes: prod.notes
    });
    addActivity({
        type: 'update',
        productId: id,
        productName: prod.name,
        categoryId: prod.categoryId,
        categoryName: getCategoryName(prod.categoryId),
        notes: 'Product updated'
    });
    showToast(tr('product.updated'), 'success');
    refreshAll();
    closeModal();
}

function deleteProduct(id) {
    confirmAction(tr('product.delete'), tr('product.confirmDelete'), () => {
        const prod = getProduct(id);
        state.products = state.products.filter(p => p.id !== id);
        saveState();
        enqueueOperation('DELETE_PRODUCT', { id });
        addActivity({
            type: 'delete',
            productId: id,
            productName: prod ? prod.name : 'Unknown',
            categoryId: prod ? prod.categoryId : null,
            categoryName: prod ? getCategoryName(prod.categoryId) : 'Unknown',
            notes: 'Product deleted'
        });
        showToast(tr('product.deleted'), 'success');
        refreshAll();
    });
}

// ==================== SALES & COUNTER ====================
function recordSale(productId, quantity = 1, notes = '') {
    const prod = getProduct(productId);
    if (!prod) return showToast(tr('product.notFound'), 'error');
    if (prod.quantity < quantity) return showToast(tr('product.noStock'), 'error');

    const prevQty = prod.quantity;
    const prevSold = prod.sold;

    prod.quantity -= quantity;
    prod.sold += quantity;
    saveState();

    const act = addActivity({
        type: 'sale',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId,
        categoryName: getCategoryName(prod.categoryId),
        quantity: quantity,
        notes: notes || `Sold ${quantity} unit(s)`,
        previousQuantity: prevQty,
        previousSold: prevSold
    });

    enqueueOperation('SALE', {
        productId: prod.id,
        quantity: quantity,
        notes: notes || `Sold ${quantity} unit(s)`,
        timestamp: act.timestamp,
        activityId: act.id
    });

    showToast(tr('sale.sold', { quantity, name: prod.name }), 'success');
    refreshAll();
    return act;
}

function undoSale(activityId) {
    const act = state.activities.find(a => a.id === activityId);
    if (!act || act.type !== 'sale') return showToast(tr('sale.cannotUndo'), 'error');

    const prod = getProduct(act.productId);
    if (!prod) return showToast(tr('sale.productGone'), 'error');

    // Restore previous state
    if (act.previousQuantity !== undefined) prod.quantity = act.previousQuantity;
    if (act.previousSold !== undefined) prod.sold = act.previousSold;

    // Mark activity as undone instead of deleting
    act.undone = true;
    act.undoneAt = Date.now();
    saveState();

    enqueueOperation('RESTOCK', {
        productId: prod.id,
        quantity: act.quantity,
        notes: `Undo sale: ${act.notes || 'Sale reversed'}`,
        timestamp: Date.now()
    });

    addActivity({
        type: 'return',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId,
        categoryName: getCategoryName(prod.categoryId),
        quantity: act.quantity,
        notes: `Undo: ${act.notes || 'Sale reversed'}`
    });

    showToast(tr('sale.undone'), 'success');
    refreshAll();
}

function addStock(productId, amount, notes = '') {
    const prod = getProduct(productId);
    if (!prod) return;
    prod.quantity += amount;
    saveState();

    const act = addActivity({
        type: 'update',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId,
        categoryName: getCategoryName(prod.categoryId),
        quantity: amount,
        notes: notes || `Restocked +${amount}`
    });

    enqueueOperation('RESTOCK', {
        productId: prod.id,
        quantity: amount,
        notes: notes || `Restocked +${amount}`,
        timestamp: Date.now(),
        activityId: act.id
    });

    showToast(tr('restock.added', { amount }), 'success');
    refreshAll();
}

// ==================== DAILY RESET ====================
function dailyReset() {
    confirmAction(tr('reset.title'), tr('reset.confirm'), () => {
        state.settings.lastResetDate = Date.now();
        saveState();
        enqueueOperation('UPDATE_SETTINGS', { key: 'general', value: state.settings });
        addActivity({ type: 'update', notes: 'Daily reset performed' });
        showToast(tr('reset.done'), 'success');
        refreshAll();
    });
}

// ==================== RENDERERS ====================
function refreshAll() {
    renderDashboard();
    renderCategories();
    renderProducts();
    renderAnalytics();
    renderActivity();
    updateCharts();
}

// ---------- Dashboard ----------
function renderDashboard() {
    const resetTime = getResetTime();
    const todayActivities = state.activities.filter(a => a.type === 'sale' && !a.undone && a.timestamp >= resetTime);
    const soldToday = todayActivities.reduce((s, a) => s + a.quantity, 0);
    const totalRevenue = getTodayRevenue();
    const catStats = getCategoryStats();

    document.getElementById('dashSoldToday').textContent = soldToday;
    document.getElementById('dashTotalCategories').textContent = state.categories.length;
    document.getElementById('dashTotalProducts').textContent = state.products.length;
    document.getElementById('dashRevenue').textContent = formatCurrency(totalRevenue);

    const sortedCats = [...catStats].sort((a, b) => b.sold - a.sold);
    document.getElementById('dashBestCategory').textContent = sortedCats.length ? sortedCats[0].name : '-';

    // Recent activity (last 5)
    const recent = state.activities.slice(0, 5);
    const list = document.getElementById('dashActivityList');
    if (!recent.length) {
        list.innerHTML = `<div class="empty-state">${tr('dash.noRecent')}</div>`;
    } else {
        list.innerHTML = recent.map(a => renderActivityItem(a)).join('');
    }
}

function renderActivityItem(a) {
    const typeLabels = {
        sale:   tr('type.sale'),
        return: tr('type.return'),
        create: tr('type.create'),
        update: tr('type.update'),
        delete: tr('type.delete'),
        note:   tr('type.note')
    };
    const label = typeLabels[a.type] || a.type;
    const systemLabel = tr('activity.system');
    const qtyLabel = tr('activity.qty');
    return `
        <div class="activity-item ${a.type}">
            <div class="activity-icon ${a.type}">${label[0]}</div>
            <div class="activity-content">
                <div class="activity-title">${a.productName || a.categoryName || systemLabel} — ${label}</div>
                <div class="activity-meta">
                    <span>${formatDateTime(a.timestamp)}</span>
                    ${a.quantity ? `<span>${qtyLabel}: ${a.quantity}</span>` : ''}
                </div>
                ${a.notes ? `<div class="activity-note">${escapeHtml(a.notes)}</div>` : ''}
            </div>
        </div>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---------- Categories ----------
function renderCategories() {
    const grid = document.getElementById('categoriesGrid');
    if (!state.categories.length) {
        grid.innerHTML = `<div class="empty-state">${tr('category.empty')}</div>`;
        return;
    }
    const editLbl   = tr('common.edit');
    const delLbl    = tr('common.delete');
    const lProds    = tr('category.products');
    const lSold     = tr('category.totalSold');
    const lStock    = tr('category.inStock');
    const lRevenue  = tr('category.revenue');
    grid.innerHTML = state.categories.map(c => {
        const prods = getProductsByCategory(c.id);
        const sold = prods.reduce((s, p) => s + p.sold, 0);
        const stock = prods.reduce((s, p) => s + p.quantity, 0);
        return `
            <div class="category-card glass">
                <div class="category-header">
                    <div class="category-name">${escapeHtml(c.name)}</div>
                    <div class="category-actions">
                        <button class="btn btn-icon btn-sm btn-secondary" onclick="openEditCategory('${c.id}')" title="${editLbl}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn btn-icon btn-sm btn-danger" onclick="deleteCategory('${c.id}')" title="${delLbl}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="category-stats">
                    <div class="category-stat">
                        <div class="category-stat-value">${prods.length}</div>
                        <div class="category-stat-label">${lProds}</div>
                    </div>
                    <div class="category-stat">
                        <div class="category-stat-value">${sold}</div>
                        <div class="category-stat-label">${lSold}</div>
                    </div>
                    <div class="category-stat">
                        <div class="category-stat-value">${stock}</div>
                        <div class="category-stat-label">${lStock}</div>
                    </div>
                    <div class="category-stat">
                        <div class="category-stat-value">${formatCurrency(prods.reduce((s,p)=>s+((p.price||0)*p.sold),0))}</div>
                        <div class="category-stat-label">${lRevenue}</div>
                    </div>
                </div>
                <div class="category-products-preview">
                    ${prods.slice(0,3).map(p => escapeHtml(p.name)).join(', ')}
                    ${prods.length > 3 ? ` +${prods.length - 3}` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// ---------- Products ----------
function renderProducts() {
    const grid = document.getElementById('productsGrid');
    const catFilter = document.getElementById('productCategoryFilter').value;
    const sortMode = document.getElementById('productSort').value;
    const search = document.getElementById('globalSearch').value.toLowerCase();

    let prods = [...state.products];
    if (catFilter) prods = prods.filter(p => p.categoryId === catFilter);
    if (search) prods = prods.filter(p => p.name.toLowerCase().includes(search));

    prods.sort((a, b) => {
        if (sortMode === 'name') return a.name.localeCompare(b.name);
        if (sortMode === 'sold') return b.sold - a.sold;
        if (sortMode === 'stock') return b.quantity - a.quantity;
        if (sortMode === 'price') return (b.price || 0) - (a.price || 0);
        return 0;
    });

    if (!prods.length) {
        grid.innerHTML = `<div class="empty-state">${tr('product.empty')}</div>`;
        return;
    }

    const editLbl  = tr('common.edit');
    const delLbl   = tr('common.delete');
    const lStock   = tr('product.inStock');
    const lSold    = tr('product.totalSold');
    const lPrice   = tr('product.price');
    const sellLbl  = tr('product.sell');
    const restock  = tr('product.restock');

    grid.innerHTML = prods.map(p => {
        const stockPct = p.quantity + p.sold > 0 ? (p.quantity / (p.quantity + p.sold)) * 100 : 0;
        const stockClass = stockPct > 50 ? 'high' : stockPct > 20 ? 'medium' : 'low';
        return `
            <div class="product-card glass">
                <div class="product-header">
                    <div>
                        <div class="product-title">${escapeHtml(p.name)}</div>
                        <div class="product-category">${escapeHtml(getCategoryName(p.categoryId))}</div>
                    </div>
                    <div class="product-actions-top">
                        <button class="btn btn-icon btn-sm btn-secondary" onclick="openEditProduct('${p.id}')" title="${editLbl}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn btn-icon btn-sm btn-danger" onclick="deleteProduct('${p.id}')" title="${delLbl}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="product-stats-row">
                    <div class="product-stat">
                        <div class="product-stat-value stock">${p.quantity}</div>
                        <div class="product-stat-label">${lStock}</div>
                    </div>
                    <div class="product-stat">
                        <div class="product-stat-value sold">${p.sold}</div>
                        <div class="product-stat-label">${lSold}</div>
                    </div>
                    <div class="product-stat">
                        <div class="product-stat-value price">${formatCurrency(p.price)}</div>
                        <div class="product-stat-label">${lPrice}</div>
                    </div>
                </div>
                <div class="stock-bar">
                    <div class="stock-bar-fill ${stockClass}" style="width: ${stockPct}%"></div>
                </div>
                ${p.notes ? `<div class="product-notes">${escapeHtml(p.notes)}</div>` : ''}
                <div class="product-actions">
                    <button class="btn btn-primary btn-sm" onclick="openSellModal('${p.id}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                        ${sellLbl}
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="openRestockModal('${p.id}')">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        ${restock}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// ---------- Activity ----------
function renderActivity() {
    const tbody = document.getElementById('activityTableBody');
    const filter = document.getElementById('activityFilter').value;
    let acts = [...state.activities];
    if (filter) acts = acts.filter(a => a.type === filter);

    if (!acts.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${tr('activity.none')}</td></tr>`;
        return;
    }

    tbody.innerHTML = acts.map(a => `
        <tr>
            <td>${formatDateTime(a.timestamp)}</td>
            <td><span class="badge badge-${a.type}">${tr('type.' + a.type)}</span></td>
            <td>${escapeHtml(a.productName || '-')}</td>
            <td>${escapeHtml(a.categoryName || '-')}</td>
            <td>${a.quantity || '-'}</td>
            <td>${escapeHtml(a.notes || '')}</td>
            <td class="actions-cell">
                ${a.type === 'sale' && !a.undone ? `<button class="btn btn-sm btn-secondary" onclick="undoSale('${a.id}')">${tr('sale.undo')}</button>` : ''}
                <button class="btn btn-sm btn-secondary" onclick="editNotePrompt('${a.id}')">${tr('activity.editNote')}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteActivity('${a.id}')">${tr('common.delete')}</button>
            </td>
        </tr>
    `).join('');
}

function editNotePrompt(id) {
    const act = state.activities.find(a => a.id === id);
    if (!act) return;
    const newNote = prompt(tr('activity.editNotePrompt'), act.notes || '');
    if (newNote !== null) {
        editActivityNotes(id, newNote);
    }
}

// ---------- Analytics ----------
function renderAnalytics() {
    const catStats = getCategoryStats();
    const prods = [...state.products].sort((a, b) => b.sold - a.sold);

    document.getElementById('insightTopProduct').textContent = prods.length ? `${prods[0].name} (${prods[0].sold} sold)` : '-';
    document.getElementById('insightLowProduct').textContent = prods.length > 1 ? `${prods[prods.length - 1].name} (${prods[prods.length - 1].sold} sold)` : '-';

    // Fast moving: highest sold with low stock ratio
    const fast = prods.filter(p => p.sold > 0).sort((a, b) => {
        const ar = a.quantity / (a.sold + 1);
        const br = b.quantity / (b.sold + 1);
        return ar - br;
    })[0];
    document.getElementById('insightFastProduct').textContent = fast ? `${fast.name}` : '-';

    // Slow moving: high stock, low sales
    const slow = prods.filter(p => p.quantity > 0).sort((a, b) => {
        const ar = a.sold / (a.quantity + 1);
        const br = b.sold / (b.quantity + 1);
        return ar - br;
    })[0];
    document.getElementById('insightSlowProduct').textContent = slow ? `${slow.name}` : '-';
}

// ==================== CHARTS ====================
function destroyChart(key) {
    if (chartInstances[key]) {
        chartInstances[key].destroy();
        delete chartInstances[key];
    }
}

function isDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

function setTheme(theme, persist = true) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    if (persist) {
        try { localStorage.setItem('salestrack-theme', next); } catch (e) { /* storage may be blocked */ }
    }
    // Re-render charts so colors match the new theme
    if (typeof updateCharts === 'function') updateCharts();
}

function setupLanguageSwitcher() {
    const wrapper = document.getElementById('langSwitcher');
    const toggle  = document.getElementById('langToggle');
    const menu    = document.getElementById('langMenu');
    if (!wrapper || !toggle || !menu) return;

    const openMenu  = () => {
        menu.hidden = false;
        // Force reflow so the CSS transition triggers
        requestAnimationFrame(() => wrapper.classList.add('open'));
        toggle.setAttribute('aria-expanded', 'true');
    };
    const closeMenu = () => {
        wrapper.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        setTimeout(() => { if (!wrapper.classList.contains('open')) menu.hidden = true; }, 160);
    };

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        wrapper.classList.contains('open') ? closeMenu() : openMenu();
    });

    menu.querySelectorAll('.lang-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-lang');
            if (window.i18n && code) window.i18n.setLang(code);
            closeMenu();
        });
    });

    document.addEventListener('click', (e) => {
        if (wrapper.classList.contains('open') && !wrapper.contains(e.target)) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && wrapper.classList.contains('open')) closeMenu();
    });

    updateLanguageSwitcherUI();
}

function updateLanguageSwitcherUI() {
    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    const codeEl = document.getElementById('langCode');
    if (codeEl) codeEl.textContent = lang.toUpperCase();
    document.querySelectorAll('#langMenu .lang-option').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
}

function setupCurrencySwitcher() {
    const cs = document.getElementById('currencySwitcher');
    if (!cs) return;
    cs.querySelectorAll('.cs-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const code = btn.dataset.code;
            if (code !== BASE_CURRENCY && !currency.getRate(code)) {
                // Trying to switch to a currency we have no rate for
                showToast('Exchange rates are loading — try again in a moment', 'info');
                currency.fetchRates(true);
                return;
            }
            currency.setActive(code);
        });
    });
    updateCurrencySwitcherUI();
}

// ==================== FX WIDGET (Google-style converter) ====================
const fx = (() => {
    let chart = null;
    let historyCache = {};   // { 'USD:30': [{date, rate}, ...] }
    let currentRange = 30;
    let updating = false;

    // UZS-per-1-unit rate for a given code (UZS=1)
    function rateFromUZS(code) {
        if (code === 'UZS') return 1;
        return currency.getRate(code);
    }

    function currencyName(code) {
        try {
            const lang = (window.i18n && window.i18n.getLang()) || 'en';
            return new Intl.DisplayNames([lang], {type: 'currency'}).of(code);
        } catch (e) {
            return ({USD: 'US Dollar', EUR: 'Euro', UZS: 'Uzbekistani Som'})[code] || code;
        }
    }

    function formatAmount(value, code) {
        const lang = (window.i18n && window.i18n.getLang()) || 'en';
        const frac = code === 'UZS' ? 2 : 4;     // converter shows finer precision
        try {
            return new Intl.NumberFormat(lang, {
                maximumFractionDigits: code === 'UZS' ? 2 : 4,
                minimumFractionDigits: code === 'UZS' ? 0 : 2
            }).format(value);
        } catch (e) {
            return value.toFixed(frac);
        }
    }

    function convert(amount, from, to) {
        if (!isFinite(amount)) return 0;
        const fromRate = rateFromUZS(from);
        const toRate   = rateFromUZS(to);
        if (!fromRate || !toRate) return null;
        // value in UZS, then to target
        return (amount * fromRate) / toRate;
    }

    function getCurrencies() {
        return {
            from: document.getElementById('fxCurrencyA')?.value || 'USD',
            to:   document.getElementById('fxCurrencyB')?.value || 'UZS'
        };
    }

    function renderRateBlock() {
        const captionEl = document.getElementById('fxCaption');
        const valueEl   = document.getElementById('fxRateValue');
        const unitEl    = document.getElementById('fxRateUnit');
        const metaEl    = document.getElementById('fxRateMeta');
        if (!captionEl) return;

        const {from, to} = getCurrencies();
        const converted = convert(1, from, to);

        captionEl.textContent = `1 ${currencyName(from)} equals`;
        unitEl.textContent    = currencyName(to);
        valueEl.textContent   = converted == null ? '—' : formatAmount(converted, to);

        const updatedAt = currency.getUpdatedAt();
        if (!currency.isProxyConfigured()) {
            metaEl.textContent = 'Proxy URL not configured';
        } else if (updatedAt) {
            const lang = (window.i18n && window.i18n.getLang()) || 'en';
            const d = new Date(updatedAt);
            const dateStr = d.toLocaleString(lang, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            metaEl.textContent = `${dateStr} · From cbu.uz`;
        } else {
            metaEl.textContent = 'Loading…';
        }
    }

    function syncConverter(source) {
        if (updating) return;
        updating = true;
        try {
            const aEl = document.getElementById('fxAmountA');
            const bEl = document.getElementById('fxAmountB');
            const {from, to} = getCurrencies();
            if (source === 'A' || source === 'currency') {
                const a = parseFloat(aEl.value);
                const result = convert(isFinite(a) ? a : 0, from, to);
                bEl.value = result == null ? '' : (to === 'UZS'
                    ? result.toFixed(2)
                    : result.toFixed(4).replace(/\.?0+$/, ''));
            } else if (source === 'B') {
                const b = parseFloat(bEl.value);
                const result = convert(isFinite(b) ? b : 0, to, from);
                aEl.value = result == null ? '' : (from === 'UZS'
                    ? result.toFixed(2)
                    : result.toFixed(4).replace(/\.?0+$/, ''));
            }
        } finally {
            updating = false;
        }
    }

    async function loadHistory(days, ccy) {
        if (!currency.isProxyConfigured()) return null;
        const key = `${ccy}:${days}`;
        if (historyCache[key]) return historyCache[key];
        try {
            const url = `${CBU_HISTORY_URL}?ccy=${encodeURIComponent(ccy)}&days=${days}`;
            const res = await fetch(url, {cache: 'no-store'});
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!Array.isArray(data) || !data.length) throw new Error('Empty history');
            historyCache[key] = data;
            return data;
        } catch (e) {
            console.warn('[fx] history fetch failed', e);
            return null;
        }
    }

    function renderChart(data, ccy) {
        const canvas = document.getElementById('fxChart');
        const empty  = document.getElementById('fxChartEmpty');
        if (!canvas) return;

        if (!data || !data.length) {
            if (chart) { chart.destroy(); chart = null; }
            if (empty) {
                empty.hidden = false;
                empty.querySelector('span').textContent = 'Exchange rate history unavailable';
            }
            return;
        }
        if (empty) empty.hidden = true;

        const t = getChartTheme();
        const lang = (window.i18n && window.i18n.getLang()) || 'en';
        const labels = data.map(d => {
            const dt = new Date(d.date);
            return dt.toLocaleDateString(lang, {month: 'short', day: 'numeric'});
        });
        const values = data.map(d => d.rate);

        if (chart) chart.destroy();

        chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: `${ccy}/UZS`,
                    data: values,
                    borderColor: t.accent,
                    backgroundColor: t.accentSoft,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: t.accent,
                    pointHoverBorderColor: t.surface,
                    pointHoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {mode: 'index', intersect: false},
                scales: {
                    x: {
                        ticks: {color: t.text, font: {size: 10}, maxRotation: 0, autoSkipPadding: 16},
                        grid: {display: false},
                        border: {color: t.border}
                    },
                    y: {
                        ticks: {color: t.text, font: {size: 10}, callback: (v) => new Intl.NumberFormat(lang).format(v)},
                        grid: {color: t.grid},
                        border: {display: false}
                    }
                },
                plugins: {
                    legend: {display: false},
                    tooltip: {
                        backgroundColor: t.tooltipBg,
                        titleColor: t.tooltipText,
                        bodyColor: t.tooltipText,
                        padding: 10, cornerRadius: 8, displayColors: false,
                        callbacks: {
                            label: (ctx) => `1 ${ccy} = ${new Intl.NumberFormat(lang).format(ctx.parsed.y)} UZS`
                        }
                    }
                }
            }
        });
    }

    async function refreshChart() {
        const {from} = getCurrencies();
        // Chart is keyed off the FROM currency (UZS as FROM defaults to USD)
        const ccy = from === 'UZS' ? 'USD' : from;
        const data = await loadHistory(currentRange, ccy);
        renderChart(data, ccy);
    }

    function setRange(days) {
        currentRange = days;
        document.querySelectorAll('.fx-tab').forEach(t =>
            t.classList.toggle('active', String(days) === t.dataset.range)
        );
        refreshChart();
    }

    function init() {
        const widget = document.getElementById('fxWidget');
        if (!widget) return;

        const aEl  = document.getElementById('fxAmountA');
        const bEl  = document.getElementById('fxAmountB');
        const aSel = document.getElementById('fxCurrencyA');
        const bSel = document.getElementById('fxCurrencyB');

        aEl.addEventListener('input',  () => syncConverter('A'));
        bEl.addEventListener('input',  () => syncConverter('B'));
        aSel.addEventListener('change', () => { renderRateBlock(); syncConverter('currency'); refreshChart(); });
        bSel.addEventListener('change', () => { renderRateBlock(); syncConverter('currency'); });

        widget.querySelectorAll('.fx-tab').forEach(tab => {
            tab.addEventListener('click', () => setRange(parseInt(tab.dataset.range, 10) || 30));
        });

        // React to rates arriving / theme & language changes
        document.addEventListener('currency:rates', () => { renderRateBlock(); syncConverter('currency'); refreshChart(); });
        document.addEventListener('i18n:change',    () => { renderRateBlock(); refreshChart(); });

        // Initial paint
        renderRateBlock();
        syncConverter('A');
        refreshChart();
    }

    return {init, refresh: () => { renderRateBlock(); syncConverter('currency'); refreshChart(); }};
})();

function updateCurrencySwitcherUI() {
    const active = currency.getActive();
    const hasRates = currency.hasRates();
    document.querySelectorAll('#currencySwitcher .cs-btn').forEach(btn => {
        const code = btn.dataset.code;
        btn.classList.toggle('active', code === active);
        const unavailable = code !== BASE_CURRENCY && !currency.getRate(code);
        btn.classList.toggle('unavailable', unavailable);
        btn.setAttribute('aria-pressed', code === active ? 'true' : 'false');
    });
    const meta = document.getElementById('rateInfo');
    if (meta) {
        if (active === BASE_CURRENCY) {
            meta.textContent = '';
            meta.hidden = true;
        } else {
            const r = currency.getRate(active);
            if (r) {
                const formatted = new Intl.NumberFormat(
                    (window.i18n && window.i18n.getLang()) || undefined,
                    { maximumFractionDigits: 2 }
                ).format(r);
                meta.hidden = false;
                meta.textContent = `1 ${active} ≈ ${formatted} UZS`;
            } else {
                meta.hidden = false;
                meta.textContent = currency.isProxyConfigured() ? '…' : 'proxy not configured';
            }
        }
    }
}

function getChartTheme() {
    if (isDarkTheme()) {
        return {
            accent:     '#26A572',
            accentSoft: 'rgba(38, 165, 114, 0.18)',
            gold:       '#D9A04A',
            goldSoft:   'rgba(217, 160, 74, 0.18)',
            text:       '#A3A8A1',
            grid:       '#262D29',
            border:     '#363D39',
            surface:    '#171D1A',
            empty:      '#1F2622',
            tooltipBg:  '#0F1411',
            tooltipText:'#F0EDE4'
        };
    }
    return {
        accent:     '#0F6E45',
        accentSoft: 'rgba(15, 110, 69, 0.10)',
        gold:       '#B47A1E',
        goldSoft:   'rgba(180, 122, 30, 0.12)',
        text:       '#8B918E',
        grid:       '#ECE8DC',
        border:     '#E7E2D5',
        surface:    '#FFFFFF',
        empty:      '#ECE8DC',
        tooltipBg:  '#1A201D',
        tooltipText:'#FFFFFF'
    };
}

function getChartColors(count) {
    // Merchant palette — emerald, copper, indigo, plum, sand, teal, rust, olive
    const base = isDarkTheme()
        ? ['#26A572', '#D9A04A', '#6B96D9', '#A782E8', '#E3C076', '#3DBDBD', '#E08A3D', '#92B463']
        : ['#0F6E45', '#B47A1E', '#1E4FA8', '#6B36B6', '#C49A4F', '#1F8F8F', '#A6651A', '#5C7A2F'];
    const colors = [];
    for (let i = 0; i < count; i++) colors.push(base[i % base.length]);
    return colors;
}

function updateCharts() {
    updateDashCategoryChart();
    updateDashTrendChart();
    updateAnalyticsCharts();
}

function updateDashCategoryChart() {
    const ctx = document.getElementById('dashCategoryChart');
    if (!ctx) return;
    destroyChart('dashCategory');
    const stats = getCategoryStats().filter(c => c.sold > 0).sort((a, b) => b.sold - a.sold);
    const t = getChartTheme();
    if (!stats.length) {
        chartInstances.dashCategory = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['No Data'],
                datasets: [{ data: [1], backgroundColor: [t.empty], borderWidth: 0 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: t.text } } }
            }
        });
        return;
    }
    chartInstances.dashCategory = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: stats.map(c => c.name),
            datasets: [{
                data: stats.map(c => c.sold),
                backgroundColor: getChartColors(stats.length),
                borderWidth: 2,
                borderColor: t.surface
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
                legend: { position: 'bottom', labels: { color: t.text, padding: 16, usePointStyle: true, boxWidth: 8 } },
                tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText, padding: 10, cornerRadius: 8, boxPadding: 4 }
            }
        }
    });
}

function updateDashTrendChart() {
    const ctx = document.getElementById('dashTrendChart');
    if (!ctx) return;
    destroyChart('dashTrend');

    // Group sales by hour for today
    const resetTime = getResetTime();
    const sales = state.activities.filter(a => a.type === 'sale' && !a.undone && a.timestamp >= resetTime);
    const hours = {};
    for (let i = 0; i < 24; i++) hours[i] = 0;
    sales.forEach(a => {
        const h = new Date(a.timestamp).getHours();
        hours[h] += a.quantity;
    });

    const labels = Object.keys(hours).map(h => `${h}:00`);
    const data = Object.values(hours);

    const t = getChartTheme();
    chartInstances.dashTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Units Sold',
                data,
                borderColor: t.accent,
                backgroundColor: t.accentSoft,
                fill: true,
                tension: 0.35,
                borderWidth: 2,
                pointBackgroundColor: t.accent,
                pointBorderColor: t.surface,
                pointBorderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { color: t.text, font: { size: 11 } }, grid: { color: t.grid }, border: { color: t.border } },
                y: { ticks: { color: t.text, font: { size: 11 } }, grid: { color: t.grid }, border: { display: false }, beginAtZero: true }
            },
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText, padding: 10, cornerRadius: 8, displayColors: false }
            }
        }
    });
}

function updateAnalyticsCharts() {
    const t = getChartTheme();
    // Pie chart - category distribution
    const pieCtx = document.getElementById('analyticsPieChart');
    if (pieCtx) {
        destroyChart('analyticsPie');
        const stats = getCategoryStats().filter(c => c.sold > 0);
        const total = stats.reduce((s, c) => s + c.sold, 0);
        if (stats.length && total > 0) {
            chartInstances.analyticsPie = new Chart(pieCtx, {
                type: 'pie',
                data: {
                    labels: stats.map(c => c.name),
                    datasets: [{
                        data: stats.map(c => c.sold),
                        backgroundColor: getChartColors(stats.length),
                        borderWidth: 2,
                        borderColor: t.surface
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        tooltip: {
                            backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText,
                            padding: 10, cornerRadius: 8, displayColors: true, boxPadding: 4,
                            callbacks: {
                                label: (ctx) => {
                                    const val = ctx.raw;
                                    const pct = ((val / total) * 100).toFixed(1);
                                    return ` ${ctx.label}: ${val} sold (${pct}%)`;
                                }
                            }
                        },
                        legend: { position: 'right', labels: { color: t.text, usePointStyle: true, padding: 14, boxWidth: 8 } }
                    }
                }
            });
        } else {
            chartInstances.analyticsPie = new Chart(pieCtx, {
                type: 'pie',
                data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: [t.empty], borderWidth: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: t.text } } } }
            });
        }
    }

    // Bar chart - product performance
    const barCtx = document.getElementById('analyticsBarChart');
    if (barCtx) {
        destroyChart('analyticsBar');
        const prods = [...state.products].filter(p => p.sold > 0).sort((a, b) => b.sold - a.sold).slice(0, 10);
        if (prods.length) {
            chartInstances.analyticsBar = new Chart(barCtx, {
                type: 'bar',
                data: {
                    labels: prods.map(p => p.name),
                    datasets: [{
                        label: 'Total Sold',
                        data: prods.map(p => p.sold),
                        backgroundColor: getChartColors(prods.length),
                        borderRadius: 6,
                        borderSkipped: false,
                        maxBarThickness: 40
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { ticks: { color: t.text, font: { size: 11 } }, grid: { display: false }, border: { color: t.border } },
                        y: { ticks: { color: t.text, font: { size: 11 } }, grid: { color: t.grid }, border: { display: false }, beginAtZero: true }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText, padding: 10, cornerRadius: 8, displayColors: false }
                    }
                }
            });
        } else {
            chartInstances.analyticsBar = new Chart(barCtx, {
                type: 'bar',
                data: { labels: ['No Data'], datasets: [{ data: [0], backgroundColor: t.empty, borderRadius: 6 }] },
                options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: t.text } }, y: { ticks: { color: t.text }, beginAtZero: true } }, plugins: { legend: { display: false } } }
            });
        }
    }

    // Line chart - sales over last 7 days
    const lineCtx = document.getElementById('analyticsLineChart');
    if (lineCtx) {
        destroyChart('analyticsLine');
        const days = [];
        const dayLabels = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            d.setHours(0, 0, 0, 0);
            const start = d.getTime();
            const end = start + 86400000;
            const count = state.activities
                .filter(a => a.type === 'sale' && !a.undone && a.timestamp >= start && a.timestamp < end)
                .reduce((s, a) => s + a.quantity, 0);
            days.push(count);
            dayLabels.push(d.toLocaleDateString((window.i18n && window.i18n.getLang()) || undefined, { weekday: 'short' }));
        }
        chartInstances.analyticsLine = new Chart(lineCtx, {
            type: 'line',
            data: {
                labels: dayLabels,
                datasets: [{
                    label: 'Daily Sales',
                    data: days,
                    borderColor: t.gold,
                    backgroundColor: t.goldSoft,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2,
                    pointBackgroundColor: t.gold,
                    pointBorderColor: t.surface,
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { ticks: { color: t.text, font: { size: 11 } }, grid: { color: t.grid }, border: { color: t.border } },
                    y: { ticks: { color: t.text, font: { size: 11 } }, grid: { color: t.grid }, border: { display: false }, beginAtZero: true }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { backgroundColor: t.tooltipBg, titleColor: t.tooltipText, bodyColor: t.tooltipText, padding: 10, cornerRadius: 8, displayColors: false }
                }
            }
        });
    }
}


// ==================== MODAL FORMS ====================
function openAddCategory() {
    openModal(tr('category.add'), `
        <div class="form-group">
            <label class="form-label">${tr('category.name')}</label>
            <input type="text" class="form-input" id="catNameInput" placeholder="${tr('category.namePlaceholder')}">
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitCategory()">${tr('category.create')}</button>
    `);
    setTimeout(() => document.getElementById('catNameInput').focus(), 100);
}

function openEditCategory(id) {
    const cat = getCategory(id);
    if (!cat) return;
    openModal(tr('category.edit'), `
        <div class="form-group">
            <label class="form-label">${tr('category.name')}</label>
            <input type="text" class="form-input" id="catNameInput" value="${escapeHtml(cat.name)}">
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitEditCategory('${id}')">${tr('common.save')}</button>
    `);
}

function submitCategory() {
    const name = document.getElementById('catNameInput').value;
    addCategory(name);
}

function submitEditCategory(id) {
    const name = document.getElementById('catNameInput').value;
    updateCategory(id, name);
}

function openAddProduct() {
    const catOptions = state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (!catOptions) {
        showToast(tr('category.first'), 'warning');
        return navigateTo('categories');
    }
    openModal(tr('product.add'), `
        <div class="form-group">
            <label class="form-label">${tr('product.nameLabel')}</label>
            <input type="text" class="form-input" id="prodNameInput" placeholder="${tr('product.namePlaceholder')}">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.categoryLabel')}</label>
            <select class="form-select" id="prodCatInput">${catOptions}</select>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.quantityLabel')}</label>
            <input type="number" class="form-input" id="prodQtyInput" value="0" min="0">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.priceLabel')}</label>
            <input type="number" class="form-input" id="prodPriceInput" placeholder="${tr('product.pricePlaceholder')}" min="0" step="0.01">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.notesLabel')}</label>
            <textarea class="form-textarea" id="prodNotesInput" placeholder="${tr('product.notesPlaceholder')}"></textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitProduct()">${tr('product.add')}</button>
    `);
}

function openEditProduct(id) {
    const prod = getProduct(id);
    if (!prod) return;
    const catOptions = state.categories.map(c => `<option value="${c.id}" ${c.id === prod.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    openModal(tr('product.edit'), `
        <div class="form-group">
            <label class="form-label">${tr('product.nameLabel')}</label>
            <input type="text" class="form-input" id="prodNameInput" value="${escapeHtml(prod.name)}">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.categoryLabel')}</label>
            <select class="form-select" id="prodCatInput">${catOptions}</select>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.quantityLabel')}</label>
            <input type="number" class="form-input" id="prodQtyInput" value="${prod.quantity}" min="0">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.priceLabel')}</label>
            <input type="number" class="form-input" id="prodPriceInput" value="${prod.price || ''}" min="0" step="0.01">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.notesLabel')}</label>
            <textarea class="form-textarea" id="prodNotesInput">${escapeHtml(prod.notes || '')}</textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitEditProduct('${id}')">${tr('common.save')}</button>
    `);
}

function submitProduct() {
    addProduct({
        name: document.getElementById('prodNameInput').value,
        categoryId: document.getElementById('prodCatInput').value,
        quantity: document.getElementById('prodQtyInput').value,
        price: document.getElementById('prodPriceInput').value,
        notes: document.getElementById('prodNotesInput').value
    });
}

function submitEditProduct(id) {
    updateProduct(id, {
        name: document.getElementById('prodNameInput').value,
        categoryId: document.getElementById('prodCatInput').value,
        quantity: document.getElementById('prodQtyInput').value,
        price: document.getElementById('prodPriceInput').value,
        notes: document.getElementById('prodNotesInput').value
    });
}

function openSellModal(productId) {
    const prod = getProduct(productId);
    if (!prod) return;
    openModal(`${tr('sale.title')}: ${escapeHtml(prod.name)}`, `
        <div class="form-group">
            <label class="form-label">${tr('sale.quantity')}</label>
            <input type="number" class="form-input" id="sellQtyInput" value="1" min="1" max="${prod.quantity}">
            <div class="form-hint">${tr('product.inStock')}: ${prod.quantity}</div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('sale.notes')}</label>
            <textarea class="form-textarea" id="sellNotesInput" placeholder="${tr('sale.notesPlaceholder')}"></textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitSale('${productId}')">${tr('sale.confirm')}</button>
    `);
}

function submitSale(productId) {
    const qty = parseInt(document.getElementById('sellQtyInput').value) || 1;
    const notes = document.getElementById('sellNotesInput').value;
    recordSale(productId, qty, notes);
    closeModal();
}

function openRestockModal(productId) {
    const prod = getProduct(productId);
    if (!prod) return;
    openModal(`${tr('restock.title')}: ${escapeHtml(prod.name)}`, `
        <div class="form-group">
            <label class="form-label">${tr('restock.amount')}</label>
            <input type="number" class="form-input" id="restockQtyInput" value="1" min="1">
        </div>
        <div class="form-group">
            <label class="form-label">${tr('restock.notes')}</label>
            <textarea class="form-textarea" id="restockNotesInput" placeholder="${tr('restock.notesPlaceholder')}"></textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitRestock('${productId}')">${tr('restock.confirm')}</button>
    `);
}

function submitRestock(productId) {
    const qty = parseInt(document.getElementById('restockQtyInput').value) || 1;
    const notes = document.getElementById('restockNotesInput').value;
    addStock(productId, qty, notes);
    closeModal();
}

// ==================== NAVIGATION ====================
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    const titleKeys = {
        dashboard:  'nav.dashboard',
        categories: 'category.title',
        products:   'product.title',
        analytics:  'analytics.title',
        activity:   'activity.title'
    };
    const key = titleKeys[page] || 'nav.dashboard';
    const titleEl = document.getElementById('pageTitle');
    titleEl.setAttribute('data-i18n', key);
    titleEl.textContent = tr(key);

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
    }

    // Refresh charts when entering dashboard or analytics
    if (page === 'dashboard' || page === 'analytics') {
        setTimeout(updateCharts, 100);
    }
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.page);
        });
    });

    // Sidebar toggle
    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });
    document.getElementById('sidebarToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
    });

    // Add buttons
    document.getElementById('addCategoryBtn').addEventListener('click', openAddCategory);
    document.getElementById('addProductBtn').addEventListener('click', openAddProduct);

    // Filters
    document.getElementById('productCategoryFilter').addEventListener('change', renderProducts);
    document.getElementById('productSort').addEventListener('change', renderProducts);
    document.getElementById('activityFilter').addEventListener('change', renderActivity);
    document.getElementById('globalSearch').addEventListener('input', () => {
        if (currentPage === 'products') renderProducts();
    });

    // Export / Import / Reset
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', (e) => {
        if (e.target.files[0]) importData(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('resetDailyBtn').addEventListener('click', dailyReset);
    document.getElementById('clearActivityBtn').addEventListener('click', () => {
        confirmAction(tr('activity.clearHistory'), tr('activity.confirmClear'), () => {
            state.activities = [];
            saveState();
            renderActivity();
            renderDashboard();
            showToast(tr('activity.cleared'), 'success');
        });
    });

    // Theme toggle
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            setTheme(next);
        });
    }

    // Language switcher
    setupLanguageSwitcher();

    // Currency switcher (on the Total Revenue card)
    setupCurrencySwitcher();

    // FX widget (Google-style converter + history chart)
    fx.init();

    // Re-render dynamic content whenever the language changes
    document.addEventListener('i18n:change', () => {
        updateLanguageSwitcherUI();
        refreshAll();
    });

    // Re-render whenever the currency or fetched rates change
    document.addEventListener('currency:change', () => {
        updateCurrencySwitcherUI();
        refreshAll();
    });
    document.addEventListener('currency:rates', () => {
        updateCurrencySwitcherUI();
        refreshAll();
    });

    // Track system theme changes if user hasn't explicitly chosen one
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const listener = (e) => {
            if (!localStorage.getItem('salestrack-theme')) {
                setTheme(e.matches ? 'dark' : 'light', false);
            }
        };
        if (mq.addEventListener) mq.addEventListener('change', listener);
        else if (mq.addListener) mq.addListener(listener);
    }

    // Update date — uses current i18n language so the weekday/month names follow the UI
    const renderDate = () => {
        const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : undefined;
        document.getElementById('currentDate').textContent =
            new Date().toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' });
    };
    setInterval(renderDate, 60000);
    renderDate();
    document.addEventListener('i18n:change', renderDate);

    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', (e) => {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('menuToggle');
        if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
            if (!sidebar.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
                sidebar.classList.remove('open');
            }
        }
    });
}

// ==================== DEMO DATA ====================
function loadDemoData() {
    if (state.categories.length || state.products.length) return;

    const clothes = { id: generateId(), name: 'Clothes', createdAt: Date.now() };
    const shoes = { id: generateId(), name: 'Shoes', createdAt: Date.now() };
    const electronics = { id: generateId(), name: 'Electronics', createdAt: Date.now() };
    const accessories = { id: generateId(), name: 'Accessories', createdAt: Date.now() };

    state.categories = [clothes, shoes, electronics, accessories];

    const demoProducts = [
        { id: generateId(), categoryId: clothes.id, name: 'Atlas Jacket', quantity: 12, sold: 5, price: 89.99, notes: 'Premium winter collection', createdAt: Date.now() },
        { id: generateId(), categoryId: clothes.id, name: 'Shuba Coat', quantity: 8, sold: 3, price: 149.99, notes: 'Russian style fur coat', createdAt: Date.now() },
        { id: generateId(), categoryId: clothes.id, name: 'Hoodie Pro', quantity: 25, sold: 12, price: 59.99, notes: '', createdAt: Date.now() },
        { id: generateId(), categoryId: shoes.id, name: 'Running Sneakers', quantity: 18, sold: 7, price: 79.99, notes: 'Size 42-45 available', createdAt: Date.now() },
        { id: generateId(), categoryId: shoes.id, name: 'Leather Boots', quantity: 6, sold: 2, price: 129.99, notes: 'Handmade leather', createdAt: Date.now() },
        { id: generateId(), categoryId: electronics.id, name: 'Wireless Earbuds', quantity: 30, sold: 15, price: 49.99, notes: 'Bluetooth 5.3', createdAt: Date.now() },
        { id: generateId(), categoryId: electronics.id, name: 'Smart Watch', quantity: 10, sold: 4, price: 199.99, notes: 'Heart rate monitor', createdAt: Date.now() },
        { id: generateId(), categoryId: accessories.id, name: 'Leather Belt', quantity: 20, sold: 6, price: 34.99, notes: '', createdAt: Date.now() },
        { id: generateId(), categoryId: accessories.id, name: 'Sunglasses', quantity: 15, sold: 3, price: 44.99, notes: 'UV400 protection', createdAt: Date.now() }
    ];

    state.products = demoProducts;

    // Generate some demo activities
    const now = Date.now();
    state.activities = [
        { id: generateId(), type: 'create', timestamp: now - 86400000 * 3, categoryId: clothes.id, categoryName: 'Clothes', notes: 'Category created' },
        { id: generateId(), type: 'create', timestamp: now - 86400000 * 3, productId: demoProducts[0].id, productName: 'Atlas Jacket', categoryId: clothes.id, categoryName: 'Clothes', notes: 'Product created' },
        { id: generateId(), type: 'sale', timestamp: now - 3600000 * 4, productId: demoProducts[0].id, productName: 'Atlas Jacket', categoryId: clothes.id, categoryName: 'Clothes', quantity: 2, notes: 'Customer bought 2 jackets for winter', previousQuantity: 14, previousSold: 3 },
        { id: generateId(), type: 'sale', timestamp: now - 3600000 * 2, productId: demoProducts[5].id, productName: 'Wireless Earbuds', categoryId: electronics.id, categoryName: 'Electronics', quantity: 1, notes: 'Gift purchase', previousQuantity: 31, previousSold: 14 },
        { id: generateId(), type: 'sale', timestamp: now - 1800000, productId: demoProducts[2].id, productName: 'Hoodie Pro', categoryId: clothes.id, categoryName: 'Clothes', quantity: 1, notes: 'Teen customer', previousQuantity: 26, previousSold: 11 },
        { id: generateId(), type: 'update', timestamp: now - 900000, productId: demoProducts[3].id, productName: 'Running Sneakers', categoryId: shoes.id, categoryName: 'Shoes', quantity: 5, notes: 'Restocked +5 from warehouse' }
    ];

    saveState();
    showToast(tr('data.demoLoaded'), 'success');
}

// ==================== INIT ====================
async function init() {
    await localDb.init();
    await loadState();
    currency.load();                  // hydrate cached active code + rates
    if (!state.categories.length && !state.products.length) {
        loadDemoData();
    }
    setupEventListeners();
    refreshAll();
    navigateTo('dashboard');

    // Populate category filter
    const filter = document.getElementById('productCategoryFilter');
    if (filter) {
        filter.innerHTML = '<option value="">All Categories</option>';
        state.categories.forEach(c => {
            filter.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
        });
    }

    // Network status event listeners
    window.addEventListener('online', () => {
        syncEngine.isOnline = true;
        syncEngine.kick();
    });
    window.addEventListener('offline', () => {
        syncEngine.isOnline = false;
        syncEngine.updateUI();
    });
    window.addEventListener('focus', () => syncEngine.kick());

    // Kick off background fetch of CBU rates
    currency.fetchRates();

    // Start background sync engine & schedule periodic cycle
    syncEngine.kick();
    setInterval(() => syncEngine.kick(), 30000);
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', init);
