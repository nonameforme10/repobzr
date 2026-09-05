/**
 * SalesTrack — VPS Backend Server
 * Production-ready Express API with PostgreSQL 16 local-first sync engine,
 * Helmet, Tiered Rate Limiting, Strict CORS, Structured Logging, and CBU currency proxy.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cbuService = require('./services/cbu');
const syncService = require('./services/syncService');
const imageStorageService = require('./services/imageStorageService');
const aiTranslationService = require('./services/aiTranslationService');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Trust reverse proxy (Nginx) so client IP and rate-limiting work properly
app.set('trust proxy', 1);

// 1. Security Headers
app.use(helmet());

// 2. Request Body Parsing (10MB to accommodate image uploads and sync operation batches)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 3. Structured JSON Request Logger Middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api') && !req.originalUrl.includes('/health')) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info'),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ip: req.ip,
        durationMs: Date.now() - start
      }));
    }
  });
  next();
});

// 4. Strict CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);

    try {
      const url = new URL(origin);
      if (url.hostname === 'caretrack.website' || url.hostname.endsWith('.caretrack.website') || url.hostname.endsWith('.vercel.app')) {
        return callback(null, true);
      }
    } catch (e) {}

    return callback(new Error(`Origin '${origin}' not allowed by CORS`));
  },
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));

// 5. Tiered Rate Limiters (Mounted BEFORE Database Processing)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many requests from this IP, please try again later.' }
});

const syncPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many sync submissions, please try again in a moment.' }
});

const syncGetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many change requests, please try again in a moment.' }
});

const dataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many snapshot requests, please try again in a moment.' }
});

// 6. Canonical /api Router
const apiRouter = express.Router();
apiRouter.use(generalLimiter);

// Health check endpoint (verifies server + PostgreSQL database connectivity)
apiRouter.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  const statusCode = dbOk ? 200 : 503;
  res.status(statusCode).json({
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Full Authoritative Data Snapshot (for initial bootstrap or reset)
apiRouter.get('/data', dataLimiter, async (req, res, next) => {
  try {
    const data = await syncService.getSnapshot();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

// Incremental Delta Sync (Client queries changes since lastSyncSeq)
apiRouter.get('/sync', syncGetLimiter, async (req, res, next) => {
  try {
    const since = req.query.since ? Number(req.query.since) : 0;
    const result = await syncService.getChangesSince(since);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Process Outbox Sync Batch from Client (Idempotent & Transactional)
apiRouter.post('/sync', syncPostLimiter, async (req, res, next) => {
  try {
    const { deviceId, operations } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
    if (!Array.isArray(operations)) return res.status(400).json({ error: 'operations must be an array' });
    if (operations.length > 100) return res.status(413).json({ error: 'Max 100 operations per batch allowed' });

    const result = await syncService.processSyncBatch(deviceId, operations);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Database Wipe / Reset Endpoint (Testing & Clean State)
apiRouter.post('/reset-database', async (req, res, next) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Truncate business and sync tracking tables, restarting identity counters
    await client.query(`
      TRUNCATE TABLE products, activities, categories, sync_operations, changes RESTART IDENTITY CASCADE
    `);
    // Clear settings and restore default UZS currency
    await client.query('DELETE FROM settings');
    await client.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, $2)",
      [JSON.stringify({ currency: 'UZS' }), Date.now()]
    );
    await client.query('COMMIT');
    console.log('[db] Database data wipe executed successfully.');
    res.status(200).json({ ok: true, message: 'Database reset successfully' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[db reset error]', err.message);
    next(err);
  } finally {
    client.release();
  }
});

// Today's CBU Rates handler
const ratesHandler = async (req, res, next) => {
  try {
    const { data, status } = await cbuService.getRates();
    res.setHeader('X-Cache', status);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
};

// Historical CBU Rates handler
const historyHandler = async (req, res, next) => {
  try {
    const { data, status } = await cbuService.getHistory(req.query.ccy, req.query.days);
    res.setHeader('X-Cache', status);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
};

// Mount canonical /api routes
apiRouter.get('/rates', ratesHandler);
apiRouter.get('/history', historyHandler);

// Backward-compatible aliases within /api
apiRouter.get('/getCbuRates', ratesHandler);
apiRouter.get('/getCbuHistory', historyHandler);

// Storage Rate Limiter
const storageUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many image upload requests, please try again in a moment.' }
});

// 1. ImageKit Image Upload
apiRouter.post('/storage/upload', storageUploadLimiter, async (req, res, next) => {
  try {
    const { image, fileName, folder } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image data is required' });
    }

    const result = await imageStorageService.uploadImage({
      file: image,
      fileName,
      folder: folder || '/products'
    });

    res.status(200).json({
      ok: true,
      url: result.url,
      fileId: result.fileId,
      name: result.name,
      size: result.size,
      thumbnailUrl: result.thumbnailUrl
    });
  } catch (err) {
    next(err);
  }
});

// 2. ImageKit Image Deletion
apiRouter.delete('/storage', async (req, res, next) => {
  try {
    const { fileId } = req.query;
    if (!fileId) {
      return res.status(400).json({ error: 'fileId query parameter is required' });
    }

    const deleted = await imageStorageService.deleteImage(fileId);
    res.status(200).json({ ok: deleted });
  } catch (err) {
    next(err);
  }
});

// 3. ImageKit Client Authentication Parameters
apiRouter.get('/storage/auth', (req, res) => {
  try {
    const params = imageStorageService.getAuthParams();
    res.status(200).json(params);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Rate Limiter (60 requests per minute)
const aiTranslateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many translation requests, please try again in a moment.' }
});

// 4. AI Multilingual Translation & Typo Correction
apiRouter.post('/ai/translate-product', aiTranslateLimiter, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Product name is required' });
    }

    const result = await aiTranslationService.translateAndCheckProduct(name);
    res.status(200).json({
      ok: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
});

// Mount router at /api
app.use('/api', apiRouter);

// 7. Global 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 8. Centralized Error Handler
app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'unhandled_server_error',
    message: err.message,
    stack: err.stack
  }));
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error'
  });
});

// 9. Server Start, Migrations & Scheduled Pruning
let server;

async function startServer() {
  try {
    // Run automated migrations before listening for traffic
    await db.runMigrations();
    console.log('[SalesTrack Backend] Database migrations up to date.');

    // Run initial changelog pruning and schedule daily
    syncService.pruneOldChanges(60).catch(err => {
      console.warn('[changelog prune error]', err.message);
    });
    setInterval(() => {
      syncService.pruneOldChanges(60).catch(err => {
        console.warn('[changelog prune error]', err.message);
      });
    }, 24 * 60 * 60 * 1000).unref();

    server = app.listen(PORT, () => {
      console.log(`[SalesTrack Backend] Listening on port ${PORT} (${NODE_ENV})`);
    });
  } catch (err) {
    console.error('[SalesTrack Backend] Fatal startup error:', err);
    process.exit(1);
  }
}

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');
      db.pool.end().then(() => {
        console.log('PostgreSQL pool closed. Exiting process.');
        process.exit(0);
      });
    });
  } else {
    process.exit(0);
  }

  setTimeout(() => {
    console.error('Forcefully exiting after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();

module.exports = { app, startServer };
