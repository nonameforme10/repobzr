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
let currentPage = 'home';

// ==================== IMAGE STORAGE ABSTRACTION ====================
/**
 * Offline-first image handling with client-side compression and pluggable remote storage.
 * - Local mode: Compresses images using canvas to max 1200px / WebP/JPEG 0.85
 *   and produces a compact Data URL (~50KB-180KB) for resilient IndexedDB storage.
 * - Remote mode: When a storage API endpoint is provided, uploads via FormData to remote S3/Cloudinary/REST API
 *   and stores the hosted CDN URL.
 */
const imageStorage = {
    // Pluggable endpoint for remote ImageKit cloud storage API
    storageApiUrl: (typeof window !== 'undefined' && window.SALESTRACK_STORAGE_API_URL) || `${API_BASE_URL}/storage/upload`,

    /**
     * Validate and process image file
     * @param {File} file
     * @returns {Promise<string>} Data URL or remote ImageKit CDN URL
     */
    async upload(file) {
        if (!file) throw new Error('No file provided');

        // 1. Validation: MIME type
        const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (!validTypes.includes(file.type)) {
            throw new Error(tr('product.imageInvalid'));
        }

        // 2. Validation: Maximum raw size (5MB)
        const MAX_SIZE = 5 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
            throw new Error(tr('product.imageInvalid'));
        }

        // 3. Compress first on client canvas: max 1200px, 0.85 quality WebP/JPEG
        const compressedDataUrl = await this.compressImageToDataUrl(file, 1200, 0.85);

        // 4. If remote storage API configured, upload to ImageKit via backend
        if (this.storageApiUrl) {
            try {
                const res = await fetch(this.storageApiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: compressedDataUrl,
                        fileName: file.name || `product_${Date.now()}.webp`,
                        folder: '/products'
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    const url = data.url || data.secure_url || data.imageUrl;
                    if (url) return url;
                } else {
                    console.warn('[imageStorage] Remote upload returned status', res.status);
                }
            } catch (err) {
                console.warn('[imageStorage] Remote upload failed, falling back to local compressed Data URL:', err);
            }
        }

        // Fallback: return compressed local Data URL
        return compressedDataUrl;
    },

    /**
     * Resizes and compresses image file onto an offscreen canvas
     */
    async compressImageToDataUrl(file, maxDimension = 1200, quality = 0.85) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxDimension || height > maxDimension) {
                        if (width > height) {
                            height = Math.round((height * maxDimension) / width);
                            width = maxDimension;
                        } else {
                            width = Math.round((width * maxDimension) / height);
                            height = maxDimension;
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    try {
                        const dataUrl = canvas.toDataURL('image/webp', quality);
                        if (dataUrl.startsWith('data:image/webp')) {
                            return resolve(dataUrl);
                        }
                    } catch (err) {}
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = () => reject(new Error(tr('product.imageInvalid')));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    },

    /**
     * Remove image reference hook
     */
    async remove(imageRef) {
        if (!imageRef) return;
        if (this.storageApiUrl && imageRef.startsWith('http')) {
            try {
                await fetch(`${this.storageApiUrl}?ref=${encodeURIComponent(imageRef)}`, { method: 'DELETE' });
            } catch (err) {
                console.warn('[imageStorage] Remote delete failed:', err);
            }
        }
    },

    /**
     * Format / validate URL reference
     */
    fromUrl(url) {
        if (typeof url === 'string' && (url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/'))) {
            return url.trim();
        }
        return null;
    }
};

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

// ==================== CROSS-TAB / CROSS-PANEL BROADCAST CHANNEL ====================
const catalogChannel = (typeof window !== 'undefined' && 'BroadcastChannel' in window)
    ? new BroadcastChannel('salestrack_channel')
    : null;

function notifyCatalogChange(type, data = {}) {
    if (catalogChannel) {
        try {
            catalogChannel.postMessage({ type, timestamp: Date.now(), ...data });
        } catch (e) {
            console.warn('[channel] Broadcast failed:', e);
        }
    }
}

if (catalogChannel) {
    catalogChannel.onmessage = async (e) => {
        const { type, productName, quantity, total } = e.data || {};
        if (type === 'SALE_RECORDED' || type === 'CATALOG_CHANGED' || type === 'PRODUCT_UPDATED') {
            await loadState();
            refreshAll();
            if (type === 'SALE_RECORDED' && productName) {
                showToast(`🛍️ POS Sale: ${productName} × ${quantity || 1} ($${Number(total || 0).toFixed(2)})`, 'success', 4500);
            }
        }
    };
}

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

        if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
            try {
                await navigator.locks.request('salestrack-sync-lock', { ifAvailable: true }, async (lock) => {
                    if (!lock) {
                        // Another tab is actively executing sync
                        return;
                    }
                    await this._executeSync();
                });
            } catch (e) {
                await this._executeSync();
            }
        } else {
            await this._executeSync();
        }
    },

    async _executeSync() {
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

                // Explicit handling of rejected offline sales or operations
                if (op.type === 'SALE') {
                    const prodId = op.payload?.productId;
                    const saleQty = Number(op.payload?.quantity) || 0;
                    const prod = state.products.find(p => p.id === prodId);
                    if (prod) {
                        // Reconcile and restore optimistic local stock deduction
                        prod.quantity += saleQty;
                        prod.sold = Math.max(0, prod.sold - saleQty);
                        await localDb.put('products', prod);
                    }
                    // Remove or tag the optimistic activity
                    if (op.payload?.activityId) {
                        state.activities = state.activities.filter(a => a.id !== op.payload.activityId);
                        await localDb.delete('activities', op.payload.activityId);
                    }
                    op.status = 'conflict';
                    await localDb.put('outbox', op);
                    refreshAll();

                    const prodName = prod?.name || 'Product';
                    showToast(`🚨 Sale rejected (${prodName}): ${rej.message || 'Insufficient stock on server'}. Local stock restored.`, 'error', 7000);
                } else if (rej.code === 'VERSION_CONFLICT') {
                    op.status = 'conflict';
                    await localDb.put('outbox', op);
                    showToast(`⚠️ Update conflict: ${rej.message || 'Item was modified on another device'}.`, 'warning', 7000);
                } else if (rej.code === 'PRODUCT_DELETED') {
                    op.status = 'conflict';
                    await localDb.put('outbox', op);
                    showToast(`⚠️ Operation rejected: Product was deleted on another device.`, 'warning', 7000);
                } else {
                    await localDb.put('outbox', op);
                    showToast(`⚠️ Sync notice: ${op.errorMessage}`, 'warning', 5000);
                }
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
                if (ch.action === 'DELETE' || ch.data?.isDeleted) {
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
                if (ch.action === 'DELETE' || ch.data?.isDeleted) {
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
            notifyCatalogChange('CATALOG_CHANGED', { reason: 'DELTA_SYNC' });
        }
    },

    async mergeSnapshot(snapshot) {
        const allOps = await localDb.getAll('outbox');
        const pendingEntityIds = new Set(
            allOps.filter(o => o.status === 'pending' || o.status === 'syncing')
                .map(o => o.payload?.productId || o.payload?.id)
                .filter(Boolean)
        );

        await Promise.all([
            localDb.clear('categories'),
            localDb.clear('products'),
            localDb.clear('activities')
        ]);

        if (Array.isArray(snapshot.categories)) {
            const mergedCats = snapshot.categories.map(sc => {
                if (pendingEntityIds.has(sc.id)) {
                    return state.categories.find(c => c.id === sc.id) || sc;
                }
                return sc;
            });
            // Preserve newly created local categories not yet known to server
            const serverCatIds = new Set(snapshot.categories.map(c => c.id));
            const pendingNewCats = state.categories.filter(c => pendingEntityIds.has(c.id) && !serverCatIds.has(c.id));
            state.categories = [...mergedCats, ...pendingNewCats];
            if (state.categories.length > 0) await localDb.putAll('categories', state.categories);
        } else {
            state.categories = [];
        }

        if (Array.isArray(snapshot.products)) {
            const mergedProds = snapshot.products.map(sp => {
                if (pendingEntityIds.has(sp.id)) {
                    return state.products.find(p => p.id === sp.id) || sp;
                }
                return sp;
            });
            // Preserve newly created local products not yet known to server
            const serverProdIds = new Set(snapshot.products.map(p => p.id));
            const pendingNewProds = state.products.filter(p => pendingEntityIds.has(p.id) && !serverProdIds.has(p.id));
            state.products = [...mergedProds, ...pendingNewProds];
            if (state.products.length > 0) await localDb.putAll('products', state.products);
        } else {
            state.products = [];
        }

        if (Array.isArray(snapshot.activities)) {
            state.activities = snapshot.activities;
            if (state.activities.length > 0) await localDb.putAll('activities', state.activities);
        } else {
            state.activities = [];
        }

        // If the server snapshot is completely empty, clean local outbox and localStorage
        if (state.categories.length === 0 && state.products.length === 0) {
            await localDb.clear('outbox');
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        }

        refreshAll();
        notifyCatalogChange('CATALOG_CHANGED', { reason: 'SNAPSHOT_SYNC' });
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

    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    const fractionDigits = displayCode === 'UZS' ? 0 : 2;

    if (displayCode === 'UZS') {
        const sym = (lang === 'ru') ? 'сум' : 'soʻm';
        const num = Math.round(converted);
        const formatted = (lang === 'en')
            ? num.toLocaleString('en-US')
            : num.toLocaleString('ru-RU');
        return `${formatted} ${sym}`;
    }

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

function parseCatalogPrice(val) {
    if (val === null || val === undefined || val === '') return 0;
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return 0;
    // Uzbek bazaar standard: sellers count in thousands ('ming soʻm'), e.g. 140 means 140 000 so'm.
    // Numbers < 10 000 (e.g. 140, 250, 50, 1.5) are in thousands.
    // Numbers >= 10 000 (e.g. 140000) are already full so'm.
    if (num < 10000) {
        return Math.round(num * 1000);
    }
    return Math.round(num);
}

function formatThousandSumPreview(val) {
    if (!val || isNaN(parseFloat(val)) || parseFloat(val) <= 0) return '';
    const fullSum = parseCatalogPrice(val);
    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    const sym = (lang === 'ru') ? 'сум' : 'soʻm';
    const thousandSym = (lang === 'ru') ? 'тыс. сум' : 'ming soʻm';
    const formattedFull = fullSum.toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU') + ' ' + sym;
    const mingVal = (fullSum / 1000).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU') + ' ' + thousandSym;

    let usdEquivalent = '';
    const usdRate = currency.getRate('USD');
    if (usdRate && usdRate > 0) {
        const inUsd = (fullSum / usdRate).toFixed(2);
        usdEquivalent = ` (≈ $${inUsd})`;
    }
    return `💰 ${mingVal} = ${formattedFull}${usdEquivalent}`;
}

function updatePricePreview(val, targetId = 'prodPricePreview') {
    const el = document.getElementById(targetId);
    if (!el) return;
    const text = formatThousandSumPreview(val);
    el.textContent = text;
    el.style.display = text ? 'flex' : 'none';
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
    if (!p) return 'Unknown';
    return getProductDisplayName(p);
}

function getProductDisplayName(p) {
    if (!p) return '';
    const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
    if (p.translations && p.translations[lang] && p.translations[lang].trim()) {
        return p.translations[lang].trim();
    }
    return p.name || '';
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
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
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

document.getElementById('modalClose')?.addEventListener('click', closeModal);
document.getElementById('modalOverlay')?.addEventListener('click', (e) => {
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
    const expVer = cat.version || 1;
    cat.name = name.trim();
    saveState();
    enqueueOperation('UPDATE_CATEGORY', { id, name: cat.name, expectedVersion: expVer });
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
    if (!data.name || !data.name.trim()) return showToast(tr('product.nameRequired'), 'error');
    const rawPrice = parseFloat(data.price);
    if (!data.price || isNaN(rawPrice) || rawPrice <= 0) {
        return showToast(tr('product.priceRequired'), 'error');
    }
    const priceNum = parseCatalogPrice(data.price);

    let qty = null;
    if (data.quantity !== undefined && data.quantity !== null && data.quantity.toString().trim() !== '') {
        const q = parseInt(data.quantity, 10);
        if (!isNaN(q) && q >= 0) qty = q;
    }

    const prod = {
        id: generateId(),
        name: data.name.trim(),
        categoryId: null,
        quantity: qty,
        sold: 0,
        price: priceNum,
        image: data.image || null,
        translations: (data.translations && typeof data.translations === 'object') ? data.translations : {},
        notes: data.notes || '',
        createdAt: Date.now()
    };
    state.products.push(prod);
    saveState();
    enqueueOperation('CREATE_PRODUCT', {
        id: prod.id,
        categoryId: null,
        name: prod.name,
        quantity: prod.quantity,
        sold: prod.sold,
        price: prod.price,
        image: prod.image,
        translations: prod.translations,
        notes: prod.notes,
        createdAt: prod.createdAt
    });
    addActivity({
        type: 'create',
        productId: prod.id,
        productName: prod.name,
        categoryId: null,
        categoryName: '',
        notes: 'Product created'
    });
    showToast(tr('product.added'), 'success');
    refreshAll();
    closeModal();
    notifyCatalogChange('PRODUCT_CREATED', { product: prod });
}

function updateProduct(id, data) {
    const prod = getProduct(id);
    if (!prod) return;
    if (!data.name || !data.name.trim()) return showToast(tr('product.nameRequired'), 'error');
    const rawPrice = parseFloat(data.price);
    if (!data.price || isNaN(rawPrice) || rawPrice <= 0) {
        return showToast(tr('product.priceRequired'), 'error');
    }
    const priceNum = parseCatalogPrice(data.price);

    prod.name = data.name.trim();
    prod.price = priceNum;

    // Quantity semantics:
    // Empty string or null explicitly sets quantity to null (untracked inventory).
    // Valid integer >= 0 sets tracked stock.
    // If undefined in data, preserves existing quantity.
    if (data.quantity !== undefined) {
        if (data.quantity === null || data.quantity.toString().trim() === '') {
            prod.quantity = null;
        } else {
            const q = parseInt(data.quantity, 10);
            if (!isNaN(q) && q >= 0) prod.quantity = q;
        }
    }

    if (data.image !== undefined) {
        prod.image = data.image;
    }
    if (data.translations !== undefined) {
        prod.translations = (data.translations && typeof data.translations === 'object') ? data.translations : {};
    }
    prod.notes = data.notes || '';
    const expVer = prod.version || 1;
    saveState();
    enqueueOperation('UPDATE_PRODUCT', {
        id,
        categoryId: prod.categoryId || null,
        name: prod.name,
        quantity: prod.quantity,
        sold: prod.sold,
        price: prod.price,
        image: prod.image,
        translations: prod.translations,
        notes: prod.notes,
        expectedVersion: expVer
    });
    addActivity({
        type: 'update',
        productId: id,
        productName: prod.name,
        categoryId: prod.categoryId || null,
        categoryName: '',
        notes: 'Product updated'
    });
    showToast(tr('product.updated'), 'success');
    refreshAll();
    closeModal();
    notifyCatalogChange('PRODUCT_UPDATED', { product: prod });
}

function deleteProduct(id) {
    confirmAction(tr('common.delete'), tr('product.confirmDelete'), () => {
        const prod = getProduct(id);
        const name = prod ? prod.name : '';
        const catId = prod ? prod.categoryId : null;
        state.products = state.products.filter(p => p.id !== id);
        saveState();
        enqueueOperation('DELETE_PRODUCT', { id });
        addActivity({
            type: 'delete',
            productId: id,
            productName: name,
            categoryId: catId,
            categoryName: getCategoryName(catId),
            notes: 'Product deleted'
        });
        showToast(tr('product.deleted'), 'success');
        refreshAll();
        notifyCatalogChange('PRODUCT_DELETED', { productId: id });
    });
}

// ==================== SALES & COUNTER ====================
function recordSale(productId, quantity = 1, notes = '') {
    const prod = getProduct(productId);
    if (!prod) return showToast(tr('product.notFound'), 'error');

    // Quantity semantics:
    // null = untracked: allow unlimited sales, do not decrement quantity.
    // 0 = out of stock: reject sale.
    // >0 = tracked: check availability and decrement.
    if (prod.quantity !== null && prod.quantity !== undefined) {
        if (prod.quantity <= 0 || prod.quantity < quantity) {
            return showToast(tr('product.noStock'), 'error');
        }
        prod.quantity -= quantity;
    }

    const prevQty = prod.quantity;
    const prevSold = prod.sold;
    prod.sold = (prod.sold || 0) + quantity;
    saveState();

    const act = addActivity({
        type: 'sale',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId || null,
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
    notifyCatalogChange('SALE_RECORDED', { productId: prod.id, productName: prod.name, quantity, total: (prod.price * quantity) });
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
    notifyCatalogChange('CATALOG_CHANGED', { reason: 'UNDO_SALE', productId: prod.id });
}

function addStock(productId, amount, notes = '') {
    const prod = getProduct(productId);
    if (!prod) return;
    if (prod.quantity === null || prod.quantity === undefined) {
        prod.quantity = amount;
    } else {
        prod.quantity += amount;
    }
    saveState();

    const act = addActivity({
        type: 'update',
        productId: prod.id,
        productName: prod.name,
        categoryId: prod.categoryId || null,
        categoryName: getCategoryName(prod.categoryId),
        quantity: amount,
        notes: notes || `Restocked +${amount}`
    });

    enqueueOperation('RESTOCK', {
        productId: prod.id,
        quantity: amount,
        notes: notes || `Restocked +${amount}`,
        timestamp: act.timestamp,
        activityId: act.id
    });

    showToast(tr('product.updated'), 'success');
    refreshAll();
    notifyCatalogChange('PRODUCT_UPDATED', { product: prod });
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

// ==================== CLEAR ALL DATA (SQL + CLIENT) ====================
async function clearAllData() {
    confirmAction(tr('action.clearAllData'), tr('action.confirmClearAllData'), async () => {
        const btn = document.getElementById('clearAllDataBtn');
        const originalHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg> <span>...</span>`;
        }
        try {
            // 1. Wipe backend PostgreSQL database
            const res = await fetch('/api/reset-database', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                throw new Error(errJson.error || `Server responded with ${res.status}`);
            }

            // 2. Clear local IndexedDB stores
            await Promise.all([
                localDb.clear('products'),
                localDb.clear('categories'),
                localDb.clear('activities'),
                localDb.clear('outbox')
            ]);
            await localDb.setMeta('lastSyncSeq', 0);

            // 3. Clear localStorage snapshot
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}

            // 4. Reset in-memory state
            state.products = [];
            state.categories = [];
            state.activities = [];

            // 5. Update UI & Category Filter
            refreshAll();
            const filter = document.getElementById('productCategoryFilter');
            if (filter) {
                filter.innerHTML = '<option value="">All Categories</option>';
            }
            syncEngine.updateUI();

            // 6. Broadcast reset to any open POS/Sellers tabs
            notifyCatalogChange('DATABASE_RESET');

            showToast(tr('action.clearAllDataSuccess'), 'success', 4000);
        } catch (err) {
            console.error('[clearAllData error]', err);
            showToast(err.message || 'Failed to clear database', 'error', 5000);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
    });
}

// ==================== RENDERERS ====================
function refreshAll() {
    renderHome();
    renderDashboard();
    renderCategories();
    renderProducts();
    renderAnalytics();
    renderActivity();
    updateCharts();
}

// ---------- Home Calendar & Blueprint Reports ----------
const homeCalendar = {
    selectedDate: new Date(),
    viewDate: new Date(),
    viewMode: 'days', // 'days' | 'months'
    initialized: false,

    init() {
        if (this.initialized) return;
        this.initialized = true;

        const todayBtn = document.getElementById('calTodayBtn');
        const selectorBtn = document.getElementById('calMonthSelector');
        const prevBtn = document.getElementById('calPrevBtn');
        const nextBtn = document.getElementById('calNextBtn');

        todayBtn?.addEventListener('click', () => {
            this.selectedDate = new Date();
            this.viewDate = new Date();
            this.viewMode = 'days';
            this.render();
            renderHomeReports();
        });

        selectorBtn?.addEventListener('click', () => {
            this.viewMode = (this.viewMode === 'days') ? 'months' : 'days';
            this.render();
        });

        prevBtn?.addEventListener('click', () => {
            if (this.viewMode === 'days') {
                this.viewDate.setMonth(this.viewDate.getMonth() - 1);
            } else {
                this.viewDate.setFullYear(this.viewDate.getFullYear() - 1);
            }
            this.render();
        });

        nextBtn?.addEventListener('click', () => {
            if (this.viewMode === 'days') {
                this.viewDate.setMonth(this.viewDate.getMonth() + 1);
            } else {
                this.viewDate.setFullYear(this.viewDate.getFullYear() + 1);
            }
            this.render();
        });
    },

    getSelectedDate() {
        return this.selectedDate;
    },

    selectDate(year, month, day) {
        this.selectedDate = new Date(year, month, day);
        this.viewDate = new Date(year, month, day);
        this.viewMode = 'days';
        this.render();
        renderHomeReports();
    },

    selectMonth(monthIndex) {
        this.viewDate.setMonth(monthIndex);
        this.viewMode = 'days';
        this.render();
    },

    render() {
        const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'en';
        const fullDateEl = document.getElementById('calFullDate');
        const monthTitleEl = document.getElementById('calMonthTitle');
        const monthSelector = document.getElementById('calMonthSelector');
        const daysView = document.getElementById('calDaysView');
        const monthsView = document.getElementById('calMonthsView');
        const weekdaysEl = document.getElementById('calWeekdays');
        const daysGridEl = document.getElementById('calDaysGrid');
        const monthsGridEl = document.getElementById('calMonthsGrid');
        const overviewSub = document.getElementById('overviewDateSubtitle');

        if (!fullDateEl) return;

        // Top bar date e.g. "воскресенье, 6 сентября"
        const locale = (lang === 'ru') ? 'ru-RU' : ((lang === 'uz') ? 'uz-UZ' : 'en-US');
        const fullDateStr = this.selectedDate.toLocaleDateString(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
        });
        fullDateEl.textContent = fullDateStr;

        if (overviewSub) {
            overviewSub.textContent = this.selectedDate.toLocaleDateString(locale, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }

        const currentYear = this.viewDate.getFullYear();
        const currentMonth = this.viewDate.getMonth();

        const monthNames = {
            ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
            uz: ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'],
            en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
        };

        const shortMonths = {
            ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
            uz: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
            en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        };

        const weekdays = {
            ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
            uz: ['Du', 'Se', 'Cho', 'Pa', 'Ju', 'Sha', 'Yak'],
            en: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
        };

        const activeMonths = monthNames[lang] || monthNames.en;
        const activeShortMonths = shortMonths[lang] || shortMonths.en;
        const activeWeekdays = weekdays[lang] || weekdays.en;

        if (this.viewMode === 'days') {
            monthSelector?.classList.remove('expanded');
            if (monthTitleEl) {
                monthTitleEl.textContent = `${activeMonths[currentMonth]} ${currentYear}`;
            }
            if (daysView) daysView.style.display = 'block';
            if (monthsView) monthsView.style.display = 'none';

            if (weekdaysEl) {
                weekdaysEl.innerHTML = activeWeekdays.map(w => `<span>${w}</span>`).join('');
            }

            if (daysGridEl) {
                daysGridEl.innerHTML = '';

                // Monday-start week: 0 for Monday, 6 for Sunday
                const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();
                const startDayIndex = (firstDayOfMonth + 6) % 7;

                const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
                const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

                const today = new Date();
                const isCurrentYear = today.getFullYear() === currentYear;
                const isCurrentMonth = today.getMonth() === currentMonth;
                const todayDate = today.getDate();

                const isSelectedYear = this.selectedDate.getFullYear() === currentYear;
                const isSelectedMonth = this.selectedDate.getMonth() === currentMonth;
                const selectedDay = this.selectedDate.getDate();

                // Trailing days of previous month
                for (let i = startDayIndex - 1; i >= 0; i--) {
                    const dayNum = daysInPrevMonth - i;
                    const prevMonth = (currentMonth === 0) ? 11 : currentMonth - 1;
                    const prevYear = (currentMonth === 0) ? currentYear - 1 : currentYear;
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'cal-day-cell other-month';
                    cell.textContent = dayNum;
                    cell.onclick = () => this.selectDate(prevYear, prevMonth, dayNum);
                    daysGridEl.appendChild(cell);
                }

                // Days of current month
                for (let d = 1; d <= daysInMonth; d++) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'cal-day-cell';
                    if (isCurrentYear && isCurrentMonth && d === todayDate) {
                        cell.classList.add('today');
                    }
                    if (isSelectedYear && isSelectedMonth && d === selectedDay) {
                        cell.classList.add('selected');
                    }
                    cell.textContent = d;
                    cell.onclick = () => this.selectDate(currentYear, currentMonth, d);
                    daysGridEl.appendChild(cell);
                }

                // Leading days of next month (complete grid to 35 or 42 cells)
                const totalRendered = startDayIndex + daysInMonth;
                const targetCells = totalRendered <= 35 ? 35 : 42;
                const remaining = targetCells - totalRendered;
                for (let n = 1; n <= remaining; n++) {
                    const nextMonth = (currentMonth === 11) ? 0 : currentMonth + 1;
                    const nextYear = (currentMonth === 11) ? currentYear + 1 : currentYear;
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'cal-day-cell other-month';
                    cell.textContent = n;
                    cell.onclick = () => this.selectDate(nextYear, nextMonth, n);
                    daysGridEl.appendChild(cell);
                }
            }
        } else {
            // Months View (Windows 11 style)
            monthSelector?.classList.add('expanded');
            if (monthTitleEl) {
                monthTitleEl.textContent = (lang === 'ru') ? `${currentYear} г.` : `${currentYear}`;
            }
            if (daysView) daysView.style.display = 'none';
            if (monthsView) monthsView.style.display = 'block';

            if (monthsGridEl) {
                monthsGridEl.innerHTML = '';
                for (let m = 0; m < 12; m++) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'cal-month-cell';
                    if (this.viewDate.getMonth() === m) {
                        cell.classList.add('selected');
                    }
                    cell.textContent = activeShortMonths[m];
                    cell.onclick = () => this.selectMonth(m);
                    monthsGridEl.appendChild(cell);
                }
            }
        }
    }
};

function renderHome() {
    homeCalendar.init();
    homeCalendar.render();
    renderHomeReports();
}

function renderHomeReports() {
    const selectedDate = homeCalendar.getSelectedDate();
    const startOfDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 0, 0, 0, 0).getTime();
    const endOfDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 23, 59, 59, 999).getTime();

    const daySales = state.activities.filter(a => a.type === 'sale' && !a.undone && a.timestamp >= startOfDay && a.timestamp <= endOfDay);

    // Compute KPIs for Daily Overview
    const totalUnits = daySales.reduce((acc, s) => acc + (s.quantity || 0), 0);
    const totalRev = daySales.reduce((acc, s) => {
        const p = getProduct(s.productId);
        const price = (p && p.price) ? p.price : (s.unitPrice || 0);
        return acc + (price * (s.quantity || 0));
    }, 0);
    const txCount = daySales.length;

    const daySoldEl = document.getElementById('homeDaySold');
    if (daySoldEl) daySoldEl.textContent = totalUnits;

    const dayRevEl = document.getElementById('homeDayRevenue');
    if (dayRevEl) dayRevEl.textContent = formatCurrency(totalRev);

    const dayTxEl = document.getElementById('homeDayTransactions');
    if (dayTxEl) dayTxEl.textContent = txCount;

    const summaryBadge = document.getElementById('homeReportsSummaryBadge');
    if (summaryBadge) {
        summaryBadge.textContent = `${totalUnits} ${tr('home.unitsSold')} · ${formatCurrency(totalRev)}`;
    }

    // Render Blueprint Reports Rows
    const reportsList = document.getElementById('homeReportsList');
    if (!reportsList) return;

    if (daySales.length === 0) {
        reportsList.innerHTML = `
            <div class="bp-empty-state">
                <div class="bp-empty-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                </div>
                <div>${tr('home.noSales')}</div>
            </div>
        `;
        return;
    }

    let rowsHtml = '';
    daySales.forEach(sale => {
        const prod = getProduct(sale.productId);
        const name = sale.productName || (prod ? getProductDisplayName(prod) : 'Unknown Product');
        const qty = sale.quantity || 1;
        const price = (prod && prod.price) ? prod.price : (sale.unitPrice || 0);
        const lineTotal = price * qty;
        const timeStr = formatTime(sale.timestamp);
        const catName = getCategoryName(sale.categoryId || (prod ? prod.categoryId : null));

        const imgHtml = (prod && prod.image)
            ? `<img src="${escapeHtml(prod.image)}" alt="${escapeHtml(name)}" loading="lazy">`
            : `<div class="bp-img-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`;

        rowsHtml += `
            <div class="bp-row">
                <div class="bp-img-wrap">
                    ${imgHtml}
                </div>
                <div class="bp-info">
                    <div class="bp-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                    <div class="bp-meta">
                        <span>🕒 ${timeStr}</span>
                        ${catName && catName !== 'Unknown' ? `<span>· ${escapeHtml(catName)}</span>` : ''}
                        ${sale.notes ? `<span>· ${escapeHtml(sale.notes)}</span>` : ''}
                    </div>
                </div>
                <div class="bp-qty-cell">
                    <span class="bp-qty-pill">${qty}</span>
                </div>
                <div class="bp-sum-cell">
                    <span class="bp-sum-val">${formatCurrency(lineTotal)}</span>
                </div>
            </div>
        `;
    });

    reportsList.innerHTML = rowsHtml;
}

// ---------- Dashboard ----------
function renderDashboard() {
    const resetTime = getResetTime();
    const todayActivities = state.activities.filter(a => a.type === 'sale' && !a.undone && a.timestamp >= resetTime);
    const soldToday = todayActivities.reduce((s, a) => s + (a.quantity || 0), 0);
    const totalRevenue = getTodayRevenue();

    const trackedStock = state.products.reduce((acc, p) => (p.quantity !== null && p.quantity !== undefined ? acc + p.quantity : acc), 0);

    const soldTodayEl = document.getElementById('dashSoldToday');
    if (soldTodayEl) soldTodayEl.textContent = soldToday;

    const trackedStockEl = document.getElementById('dashTrackedStock');
    if (trackedStockEl) trackedStockEl.textContent = trackedStock;

    const totalProdEl = document.getElementById('dashTotalProducts');
    if (totalProdEl) totalProdEl.textContent = state.products.length;

    const revEl = document.getElementById('dashRevenue');
    if (revEl) revEl.textContent = formatCurrency(totalRevenue);

    const sortedProds = [...state.products].sort((a, b) => (b.sold || 0) - (a.sold || 0));
    const bestProductEl = document.getElementById('dashBestProduct');
    if (bestProductEl) {
        bestProductEl.textContent = (sortedProds.length && sortedProds[0].sold > 0)
            ? `${sortedProds[0].name} (${sortedProds[0].sold})`
            : (sortedProds.length ? sortedProds[0].name : '-');
    }

    // Recent activity (last 5)
    const recent = state.activities.slice(0, 5);
    const list = document.getElementById('dashActivityList');
    if (list) {
        if (!recent.length) {
            list.innerHTML = `<div class="empty-state">${tr('dash.noRecent')}</div>`;
        } else {
            list.innerHTML = recent.map(a => renderActivityItem(a)).join('');
        }
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
    if (!grid) return;
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
    if (!grid) return;
    const catFilter = document.getElementById('productCategoryFilter')?.value || '';
    const sortMode = document.getElementById('productSort')?.value || 'name';
    const search = (document.getElementById('globalSearch')?.value || '').toLowerCase();

    let prods = [...state.products];
    if (catFilter) prods = prods.filter(p => p.categoryId === catFilter);
    if (search) {
        prods = prods.filter(p => {
            const disp = getProductDisplayName(p).toLowerCase();
            const orig = (p.name || '').toLowerCase();
            const uz = (p.translations?.uz || '').toLowerCase();
            const ru = (p.translations?.ru || '').toLowerCase();
            const en = (p.translations?.en || '').toLowerCase();
            return disp.includes(search) || orig.includes(search) || uz.includes(search) || ru.includes(search) || en.includes(search);
        });
    }

    prods.sort((a, b) => {
        if (sortMode === 'name') return getProductDisplayName(a).localeCompare(getProductDisplayName(b));
        if (sortMode === 'sold') return (b.sold || 0) - (a.sold || 0);
        if (sortMode === 'stock') {
            const aQty = (a.quantity !== null && a.quantity !== undefined) ? a.quantity : -1;
            const bQty = (b.quantity !== null && b.quantity !== undefined) ? b.quantity : -1;
            return bQty - aQty;
        }
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
        const isUntracked = (p.quantity === null || p.quantity === undefined);
        const stockPct = (!isUntracked && (p.quantity + p.sold > 0)) ? (p.quantity / (p.quantity + p.sold)) * 100 : 0;
        const stockClass = isUntracked ? '' : (stockPct > 50 ? 'high' : stockPct > 20 ? 'medium' : 'low');

        const stockDisplay = isUntracked
            ? `<div class="product-stat-value stock untracked" title="${tr('product.untracked')}">—</div>`
            : (p.quantity === 0
                ? `<div class="product-stat-value stock" style="color: var(--danger);" title="${tr('product.outOfStock')}">0</div>`
                : `<div class="product-stat-value stock">${p.quantity}</div>`);

        const imgHtml = p.image ? `
            <div class="product-card-thumb-wrap">
                <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" class="product-card-thumb" loading="lazy" onerror="this.parentElement.style.display='none'">
            </div>
        ` : '';

        const dispTitle = getProductDisplayName(p);
        const transList = p.translations ? [
            p.translations.uz ? `UZ: ${p.translations.uz}` : '',
            p.translations.ru ? `RU: ${p.translations.ru}` : '',
            p.translations.en ? `EN: ${p.translations.en}` : ''
        ].filter(Boolean) : [];
        const transSubtitle = (transList.length > 0)
            ? `<div class="product-trans-preview" style="font-size: 0.6875rem; color: var(--ink-muted); margin-top: 3px;">${escapeHtml(transList.join(' · '))}</div>`
            : '';

        return `
            <div class="product-card glass">
                ${imgHtml}
                <div class="product-header">
                    <div>
                        <div class="product-title">${escapeHtml(dispTitle)}</div>
                        ${transSubtitle}
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
                        ${stockDisplay}
                        <div class="product-stat-label">${lStock}</div>
                    </div>
                    <div class="product-stat">
                        <div class="product-stat-value sold">${p.sold || 0}</div>
                        <div class="product-stat-label">${lSold}</div>
                    </div>
                    <div class="product-stat">
                        <div class="product-stat-value price">${formatCurrency(p.price)}</div>
                        <div class="product-stat-label">${lPrice}</div>
                    </div>
                </div>
                ${!isUntracked ? `
                <div class="stock-bar">
                    <div class="stock-bar-fill ${stockClass}" style="width: ${stockPct}%"></div>
                </div>` : ''}
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
    if (!tbody) return;
    const filter = document.getElementById('activityFilter')?.value || '';
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
    const topEl = document.getElementById('insightTopProduct');
    const lowEl = document.getElementById('insightLowProduct');
    const fastEl = document.getElementById('insightFastProduct');
    const slowEl = document.getElementById('insightSlowProduct');
    if (!topEl && !lowEl && !fastEl && !slowEl) return;

    const catStats = getCategoryStats();
    const prods = [...state.products].sort((a, b) => b.sold - a.sold);

    if (topEl) topEl.textContent = prods.length ? `${prods[0].name} (${prods[0].sold} sold)` : '-';
    if (lowEl) lowEl.textContent = prods.length > 1 ? `${prods[prods.length - 1].name} (${prods[prods.length - 1].sold} sold)` : '-';

    // Fast moving: highest sold with low stock ratio
    if (fastEl) {
        const fast = prods.filter(p => p.sold > 0).sort((a, b) => {
            const ar = a.quantity / (a.sold + 1);
            const br = b.quantity / (b.sold + 1);
            return ar - br;
        })[0];
        fastEl.textContent = fast ? `${fast.name}` : '-';
    }

    // Slow moving: high stock, low sales
    if (slowEl) {
        const slow = prods.filter(p => p.quantity > 0).sort((a, b) => {
            const ar = a.sold / (a.quantity + 1);
            const br = b.sold / (b.quantity + 1);
            return ar - br;
        })[0];
        slowEl.textContent = slow ? `${slow.name}` : '-';
    }
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
    const root = document.documentElement;
    root.classList.add('no-transitions');
    root.setAttribute('data-theme', next);
    if (persist) {
        try { localStorage.setItem('salestrack-theme', next); } catch (e) { /* storage may be blocked */ }
    }
    // Re-enable transitions and update charts in next idle turn so click interaction (INP) is instantaneous
    requestAnimationFrame(() => {
        root.classList.remove('no-transitions');
        setTimeout(() => {
            if (typeof updateCharts === 'function') updateCharts();
            if (typeof fx !== 'undefined' && fx.refresh) fx.refresh();
        }, 30);
    });
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
    const toggleBtn = document.getElementById('langToggle');
    if (toggleBtn) toggleBtn.setAttribute('aria-label', `Language: ${lang.toUpperCase()}`);
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
                empty.style.display = 'flex';
                empty.querySelector('span').textContent = 'Exchange rate history unavailable';
            }
            return;
        }
        if (empty) {
            empty.hidden = true;
            empty.style.display = 'none';
        }

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
        document.querySelectorAll('.fx-tab').forEach(t => {
            const isActive = String(days) === t.dataset.range;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', String(isActive));
        });
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
    if (currentPage === 'dashboard') {
        updateDashCategoryChart();
        updateDashTrendChart();
    } else if (currentPage === 'analytics') {
        updateAnalyticsCharts();
    }
}

function updateDashCategoryChart() {
    const ctx = document.getElementById('dashCategoryChart');
    if (!ctx) return;
    destroyChart('dashCategory');
    const prods = [...state.products].filter(p => (p.sold || 0) > 0).sort((a, b) => b.sold - a.sold).slice(0, 8);
    const t = getChartTheme();
    if (!prods.length) {
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
            labels: prods.map(p => p.name),
            datasets: [{
                data: prods.map(p => p.sold),
                backgroundColor: getChartColors(prods.length),
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
                x: {
                    ticks: {
                        color: t.text,
                        font: { size: 10 },
                        maxTicksLimit: 6,
                        maxRotation: 0,
                        minRotation: 0,
                        autoSkip: true
                    },
                    grid: { color: t.grid },
                    border: { color: t.border }
                },
                y: {
                    ticks: {
                        color: t.text,
                        font: { size: 11 },
                        precision: 0,
                        stepSize: 1
                    },
                    grid: { color: t.grid },
                    border: { display: false },
                    beginAtZero: true
                }
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
    // Pie chart - product sales distribution
    const pieCtx = document.getElementById('analyticsPieChart');
    if (pieCtx) {
        destroyChart('analyticsPie');
        const prods = [...state.products].filter(p => (p.sold || 0) > 0).sort((a, b) => b.sold - a.sold).slice(0, 10);
        const total = prods.reduce((s, p) => s + p.sold, 0);
        if (prods.length && total > 0) {
            chartInstances.analyticsPie = new Chart(pieCtx, {
                type: 'pie',
                data: {
                    labels: prods.map(p => p.name),
                    datasets: [{
                        data: prods.map(p => p.sold),
                        backgroundColor: getChartColors(prods.length),
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
                        x: {
                            ticks: {
                                color: t.text,
                                font: { size: 10 },
                                maxRotation: 45,
                                maxTicksLimit: 8,
                                autoSkip: true
                            },
                            grid: { display: false },
                            border: { color: t.border }
                        },
                        y: {
                            ticks: {
                                color: t.text,
                                font: { size: 11 },
                                precision: 0,
                                stepSize: 1
                            },
                            grid: { color: t.grid },
                            border: { display: false },
                            beginAtZero: true
                        }
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
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { ticks: { color: t.text, font: { size: 10 } } },
                        y: { ticks: { color: t.text, font: { size: 11 }, precision: 0, stepSize: 1 }, beginAtZero: true }
                    },
                    plugins: { legend: { display: false } }
                }
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
                    x: {
                        ticks: {
                            color: t.text,
                            font: { size: 10 },
                            maxRotation: 0,
                            autoSkip: true
                        },
                        grid: { color: t.grid },
                        border: { color: t.border }
                    },
                    y: {
                        ticks: {
                            color: t.text,
                            font: { size: 11 },
                            precision: 0,
                            stepSize: 1
                        },
                        grid: { color: t.grid },
                        border: { display: false },
                        beginAtZero: true
                    }
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

let currentModalImage = null;

function renderImageUploadArea() {
    const container = document.getElementById('imageUploadContainer');
    if (!container) return;

    if (currentModalImage) {
        container.innerHTML = `
            <div class="image-preview-card">
                <img src="${escapeHtml(currentModalImage)}" alt="Preview" class="image-preview-thumb">
                <div class="image-preview-info">
                    <div class="image-preview-title">${tr('product.imageLabel')}</div>
                    <div class="image-preview-meta">Image attached</div>
                    <div class="image-preview-actions">
                        <button type="button" class="btn btn-outline btn-sm" onclick="triggerImageFilePicker()">${tr('product.imageChange')}</button>
                        <button type="button" class="btn btn-danger btn-sm" onclick="clearModalImage()">${tr('product.imageRemove')}</button>
                    </div>
                </div>
            </div>
            <input type="file" id="prodImageFileInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display: none;">
        `;
    } else {
        container.innerHTML = `
            <div class="image-upload-zone" id="imageDropzone" onclick="triggerImageFilePicker()">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <div class="image-upload-label">${tr('product.imageLabel')}</div>
                <div class="image-upload-hint">${tr('product.imageDropzone')}</div>
            </div>
            <input type="file" id="prodImageFileInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display: none;">
        `;
    }

    const fileInput = document.getElementById('prodImageFileInput');
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) await handleSelectedImageFile(file);
        });
    }

    const dropzone = document.getElementById('imageDropzone');
    if (dropzone) {
        ['dragenter', 'dragover'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('drag-over');
            });
        });
        dropzone.addEventListener('drop', async (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) await handleSelectedImageFile(file);
        });
    }
}

function triggerImageFilePicker() {
    const fileInput = document.getElementById('prodImageFileInput');
    if (fileInput) fileInput.click();
}

async function handleSelectedImageFile(file) {
    try {
        const imageRef = await imageStorage.upload(file);
        currentModalImage = imageRef;
        renderImageUploadArea();
    } catch (err) {
        showToast(err.message || tr('product.imageInvalid'), 'error');
    }
}

function clearModalImage() {
    currentModalImage = null;
    renderImageUploadArea();
}

let isAiTranslating = false;
let lastAiTranslatedName = '';

function getAiTranslationBoxHtml(translations = {}, hasTypo = false, original = '', corrected = '', typoExplanation = '') {
    const uzVal = translations.uz || '';
    const ruVal = translations.ru || '';
    const enVal = translations.en || '';
    return `
        <div id="aiTypoBanner" class="ai-typo-banner" style="${hasTypo ? 'display:flex;' : 'display:none;'}">
            <span>💡 Typo detected: "<b>${escapeHtml(original)}</b>" → Suggested: "<b>${escapeHtml(corrected)}</b>"${typoExplanation ? ` (${escapeHtml(typoExplanation)})` : ''}</span>
            <button type="button" class="btn btn-primary btn-sm" onclick="applyTypoCorrection('${escapeHtml(corrected).replace(/'/g, "\\'")}')">Apply</button>
        </div>
        <div id="aiTranslationsContainer" class="ai-translations-box">
            <div class="ai-trans-header">
                <span class="ai-trans-title">Multilingual Names (UZ · RU · EN)</span>
                <span class="ai-trans-badge" id="aiProviderBadge">AI Ready</span>
            </div>
            <div class="ai-trans-grid">
                <div class="ai-trans-field">
                    <span class="ai-flag">🇺🇿 UZ</span>
                    <input type="text" class="form-input trans-input" id="transUzInput" value="${escapeHtml(uzVal)}" placeholder="Oʻzbekcha (masalan: Jinsi kurtka)" title="${escapeHtml(uzVal)}">
                </div>
                <div class="ai-trans-field">
                    <span class="ai-flag">🇷🇺 RU</span>
                    <input type="text" class="form-input trans-input" id="transRuInput" value="${escapeHtml(ruVal)}" placeholder="Русский (например: Джинсовая куртка)" title="${escapeHtml(ruVal)}">
                </div>
                <div class="ai-trans-field">
                    <span class="ai-flag">🇬🇧 EN</span>
                    <input type="text" class="form-input trans-input" id="transEnInput" value="${escapeHtml(enVal)}" placeholder="English (e.g. Denim Jacket)" title="${escapeHtml(enVal)}">
                </div>
            </div>
        </div>
    `;
}

async function triggerAiTranslation(force = true) {
    const nameInput = document.getElementById('prodNameInput');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name || (name === lastAiTranslatedName && !force)) return;
    if (isAiTranslating) return;

    const btn = document.getElementById('btnAiTranslate');
    const badge = document.getElementById('aiProviderBadge');
    isAiTranslating = true;
    if (btn) {
        btn.classList.add('loading');
        const textSpan = btn.querySelector('span');
        if (textSpan) textSpan.textContent = 'Checking AI...';
    }
    if (badge) badge.textContent = 'Translating...';

    try {
        const res = await fetch('/api/ai/translate-product', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.ok && data.translations) {
            lastAiTranslatedName = name;
            const uzInput = document.getElementById('transUzInput');
            const ruInput = document.getElementById('transRuInput');
            const enInput = document.getElementById('transEnInput');
            if (uzInput) { uzInput.value = data.translations.uz || ''; uzInput.title = data.translations.uz || ''; }
            if (ruInput) { ruInput.value = data.translations.ru || ''; ruInput.title = data.translations.ru || ''; }
            if (enInput) { enInput.value = data.translations.en || ''; enInput.title = data.translations.en || ''; }

            const banner = document.getElementById('aiTypoBanner');
            if (banner) {
                if (data.hasTypo && data.corrected && data.corrected.toLowerCase() !== name.toLowerCase()) {
                    banner.style.display = 'flex';
                    banner.innerHTML = `
                        <span>💡 Typo detected: "<b>${escapeHtml(data.original)}</b>" → Suggested: "<b>${escapeHtml(data.corrected)}</b>"${data.typoExplanation ? ` (${escapeHtml(data.typoExplanation)})` : ''}</span>
                        <button type="button" class="btn btn-primary btn-sm" onclick="applyTypoCorrection('${escapeHtml(data.corrected).replace(/'/g, "\\'")}')">Apply</button>
                    `;
                } else {
                    banner.style.display = 'none';
                }
            }

            if (badge) badge.textContent = '✨ Ready';
        }
    } catch (err) {
        console.warn('[AI translation error]', err);
        if (badge) badge.textContent = 'Offline';
    } finally {
        isAiTranslating = false;
        if (btn) {
            btn.classList.remove('loading');
            const textSpan = btn.querySelector('span');
            if (textSpan) textSpan.textContent = 'AI Check & Translate';
        }
    }
}

function onProdNameBlur() {
    const uzVal = document.getElementById('transUzInput')?.value.trim();
    const ruVal = document.getElementById('transRuInput')?.value.trim();
    if (!uzVal && !ruVal) {
        triggerAiTranslation(false);
    }
}

function applyTypoCorrection(corrected) {
    const nameInput = document.getElementById('prodNameInput');
    if (nameInput) {
        nameInput.value = corrected;
    }
    const banner = document.getElementById('aiTypoBanner');
    if (banner) banner.style.display = 'none';
    showToast(`Corrected to "${corrected}"`, 'success');
}

function openAddProduct() {
    currentModalImage = null;
    lastAiTranslatedName = '';
    openModal(tr('product.add'), `
        <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <label class="form-label" style="margin-bottom: 0;">${tr('product.nameLabel')}</label>
                <button type="button" class="ai-translate-btn" id="btnAiTranslate" onclick="triggerAiTranslation(true)" title="AI Typo Check & Multilingual Translation">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <span>AI Check &amp; Translate</span>
                </button>
            </div>
            <input type="text" class="form-input" id="prodNameInput" placeholder="${tr('product.namePlaceholder')}" onblur="onProdNameBlur()">
            ${getAiTranslationBoxHtml()}
        </div>
        <div class="form-group">
            <div class="image-upload-wrapper" id="imageUploadContainer"></div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.priceLabel')}</label>
            <div style="position:relative;display:flex;align-items:center;">
                <input type="number" class="form-input" id="prodPriceInput" placeholder="${tr('product.pricePlaceholder')}" min="0.1" step="any" required style="padding-right:95px;" oninput="updatePricePreview(this.value, 'prodPricePreview')">
                <span style="position:absolute;right:14px;color:var(--ink-muted);font-weight:600;font-size:0.875rem;pointer-events:none;">${tr('currency.thousandSum')}</span>
            </div>
            <div id="prodPricePreview" style="margin-top:6px;font-size:0.8125rem;font-weight:600;color:var(--accent);display:none;"></div>
            <div class="form-hint" style="margin-top:4px;">${tr('product.priceHint')}</div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.quantityLabel')}</label>
            <input type="number" class="form-input" id="prodQtyInput" placeholder="${tr('product.quantityPlaceholder')}" min="0">
            <div class="form-hint">${tr('product.quantityHint')}</div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.notesLabel')}</label>
            <textarea class="form-textarea" id="prodNotesInput" placeholder="${tr('product.notesPlaceholder')}"></textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitProduct()">${tr('product.add')}</button>
    `);
    renderImageUploadArea();
    setTimeout(() => document.getElementById('prodNameInput')?.focus(), 100);
}

function openEditProduct(id) {
    const prod = getProduct(id);
    if (!prod) return;
    currentModalImage = prod.image || null;
    lastAiTranslatedName = prod.name || '';
    const qtyVal = (prod.quantity !== null && prod.quantity !== undefined) ? prod.quantity : '';
    const priceVal = (prod.price !== null && prod.price !== undefined) ? (prod.price >= 1000 ? Math.round(prod.price / 1000) : prod.price) : '';
    const initialPreview = priceVal ? formatThousandSumPreview(priceVal) : '';
    openModal(tr('product.edit'), `
        <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <label class="form-label" style="margin-bottom: 0;">${tr('product.nameLabel')}</label>
                <button type="button" class="ai-translate-btn" id="btnAiTranslate" onclick="triggerAiTranslation(true)" title="AI Typo Check & Multilingual Translation">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    <span>AI Check &amp; Translate</span>
                </button>
            </div>
            <input type="text" class="form-input" id="prodNameInput" value="${escapeHtml(prod.name)}" onblur="onProdNameBlur()">
            ${getAiTranslationBoxHtml(prod.translations || {})}
        </div>
        <div class="form-group">
            <div class="image-upload-wrapper" id="imageUploadContainer"></div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.priceLabel')}</label>
            <div style="position:relative;display:flex;align-items:center;">
                <input type="number" class="form-input" id="prodPriceInput" value="${priceVal}" min="0.1" step="any" required style="padding-right:95px;" oninput="updatePricePreview(this.value, 'prodPricePreview')">
                <span style="position:absolute;right:14px;color:var(--ink-muted);font-weight:600;font-size:0.875rem;pointer-events:none;">${tr('currency.thousandSum')}</span>
            </div>
            <div id="prodPricePreview" style="margin-top:6px;font-size:0.8125rem;font-weight:600;color:var(--accent);display:${initialPreview ? 'flex' : 'none'};">${initialPreview}</div>
            <div class="form-hint" style="margin-top:4px;">${tr('product.priceHint')}</div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.quantityLabel')}</label>
            <input type="number" class="form-input" id="prodQtyInput" value="${qtyVal}" placeholder="${tr('product.quantityPlaceholder')}" min="0">
            <div class="form-hint">${tr('product.quantityHint')}</div>
        </div>
        <div class="form-group">
            <label class="form-label">${tr('product.notesLabel')}</label>
            <textarea class="form-textarea" id="prodNotesInput">${escapeHtml(prod.notes || '')}</textarea>
        </div>
    `, `
        <button class="btn btn-secondary" onclick="closeModal()">${tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick="submitEditProduct('${id}')">${tr('common.save')}</button>
    `);
    renderImageUploadArea();
}

function submitProduct() {
    const translations = {
        uz: document.getElementById('transUzInput')?.value.trim() || '',
        ru: document.getElementById('transRuInput')?.value.trim() || '',
        en: document.getElementById('transEnInput')?.value.trim() || ''
    };
    addProduct({
        name: document.getElementById('prodNameInput').value,
        quantity: document.getElementById('prodQtyInput').value,
        price: document.getElementById('prodPriceInput').value,
        image: currentModalImage,
        translations,
        notes: document.getElementById('prodNotesInput').value
    });
}

function submitEditProduct(id) {
    const translations = {
        uz: document.getElementById('transUzInput')?.value.trim() || '',
        ru: document.getElementById('transRuInput')?.value.trim() || '',
        en: document.getElementById('transEnInput')?.value.trim() || ''
    };
    updateProduct(id, {
        name: document.getElementById('prodNameInput').value,
        quantity: document.getElementById('prodQtyInput').value,
        price: document.getElementById('prodPriceInput').value,
        image: currentModalImage,
        translations,
        notes: document.getElementById('prodNotesInput').value
    });
}

function openSellModal(productId) {
    const prod = getProduct(productId);
    if (!prod) return;
    const isUntracked = (prod.quantity === null || prod.quantity === undefined);
    const maxAttr = isUntracked ? '' : `max="${prod.quantity}"`;
    const stockHint = isUntracked ? tr('product.untracked') : prod.quantity;
    openModal(`${tr('sale.title')}: ${escapeHtml(prod.name)}`, `
        <div class="form-group">
            <label class="form-label">${tr('sale.quantity')}</label>
            <input type="number" class="form-input" id="sellQtyInput" value="1" min="1" ${maxAttr}>
            <div class="form-hint">${tr('product.inStock')}: ${stockHint}</div>
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
        home:       'nav.home',
        dashboard:  'nav.dashboard',
        categories: 'category.title',
        products:   'product.title',
        analytics:  'analytics.title',
        activity:   'activity.title'
    };
    const key = titleKeys[page] || 'nav.home';
    const titleEl = document.getElementById('pageTitle');
    titleEl.setAttribute('data-i18n', key);
    titleEl.textContent = tr(key);

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarOverlay')?.classList.remove('active');
    }

    // Refresh charts when entering dashboard or analytics
    if (page === 'dashboard' || page === 'analytics') {
        requestAnimationFrame(() => {
            setTimeout(updateCharts, 60);
        });
    }
    if (page === 'home') {
        renderHome();
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

    // Sidebar toggle and overlay
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const openSidebar = () => {
        sidebar?.classList.add('open');
        sidebarOverlay?.classList.add('active');
    };
    const closeSidebar = () => {
        sidebar?.classList.remove('open');
        sidebarOverlay?.classList.remove('active');
    };

    document.getElementById('menuToggle')?.addEventListener('click', () => {
        if (sidebar?.classList.contains('open')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });
    document.getElementById('sidebarToggle')?.addEventListener('click', closeSidebar);
    sidebarOverlay?.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar?.classList.contains('open')) {
            closeSidebar();
        }
    });

    // Add buttons
    document.getElementById('addCategoryBtn')?.addEventListener('click', openAddCategory);
    document.getElementById('addProductBtn')?.addEventListener('click', openAddProduct);

    // Filters
    document.getElementById('productCategoryFilter')?.addEventListener('change', renderProducts);
    document.getElementById('productSort')?.addEventListener('change', renderProducts);
    document.getElementById('activityFilter')?.addEventListener('change', renderActivity);
    document.getElementById('globalSearch')?.addEventListener('input', () => {
        if (currentPage === 'products') renderProducts();
    });

    // Export / Import / Reset
    document.getElementById('exportBtn')?.addEventListener('click', exportData);
    document.getElementById('importBtn')?.addEventListener('click', () => document.getElementById('importFile')?.click());
    document.getElementById('importFile')?.addEventListener('change', (e) => {
        if (e.target.files[0]) importData(e.target.files[0]);
        e.target.value = '';
    });
    document.getElementById('resetDailyBtn')?.addEventListener('click', dailyReset);
    document.getElementById('clearAllDataBtn')?.addEventListener('click', clearAllData);
    document.getElementById('clearActivityBtn')?.addEventListener('click', () => {
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

    // Update revenue display and switcher pills when active currency or rates change
    const onCurrencyUpdated = () => {
        updateCurrencySwitcherUI();
        const revEl = document.getElementById('dashRevenue');
        if (revEl) revEl.textContent = formatCurrency(getTodayRevenue());
        renderHomeReports();
    };
    document.addEventListener('currency:change', onCurrencyUpdated);
    document.addEventListener('currency:rates', onCurrencyUpdated);

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
        const dateEl = document.getElementById('currentDate');
        if (!dateEl) return;
        const lang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : undefined;
        dateEl.textContent =
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

// ==================== CLEAN SLATE / RESET ====================
async function purgeDemoDataIfPresent() {
    const demoProductNames = new Set([
        'Atlas Jacket', 'Shuba Coat', 'Hoodie Pro', 'Running Sneakers',
        'Leather Boots', 'Wireless Earbuds', 'Smart Watch', 'Leather Belt', 'Sunglasses'
    ]);
    if (state.products.some(p => demoProductNames.has(p.name))) {
        state.products = [];
        state.categories = [];
        state.activities = [];
        await Promise.all([
            localDb.clear('products'),
            localDb.clear('categories'),
            localDb.clear('activities'),
            localDb.clear('outbox')
        ]);
        await localDb.setMeta('lastSyncSeq', 0);
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
}

// ==================== INIT ====================
async function init() {
    // Request persistent storage defensively to prevent browser eviction
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
        try {
            const isPersisted = await navigator.storage.persist();
            console.log(`[storage] Persistent storage granted: ${isPersisted}`);
        } catch (e) {
            console.warn('[storage] navigator.storage.persist error:', e);
        }
    }

    await localDb.init();
    await loadState();
    await purgeDemoDataIfPresent();
    currency.load();                  // hydrate cached active code + rates
    homeCalendar.init();
    setupEventListeners();
    refreshAll();
    navigateTo('home');

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
