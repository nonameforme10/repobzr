/**
 * SalesTrack — VPS Backend Server
 * Production-ready Express API with PostgreSQL 16 local-first sync engine,
 * Helmet, Rate Limiting, Strict CORS, and CBU currency proxy.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cbuService = require('./services/cbu');
const syncService = require('./services/syncService');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Trust reverse proxy (Nginx) so client IP and rate-limiting work properly
app.set('trust proxy', 1);

// 1. Security Headers
app.use(helmet());

// 2. Request Body Parsing (1MB for sync operation batches)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 3. Strict CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server requests, curl, or when no origin header is provided
    if (!origin) return callback(null, true);

    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin '${origin}' not allowed by CORS`));
  },
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));

// 4. Rate Limiting for API routes (300 requests per 15 min per IP for sync activity)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});

// 5. Canonical /api Router
const apiRouter = express.Router();
apiRouter.use(limiter);

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
apiRouter.get('/data', async (req, res, next) => {
  try {
    const data = await syncService.getSnapshot();
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

// Incremental Delta Sync (Client queries changes since lastSyncSeq)
apiRouter.get('/sync', async (req, res, next) => {
  try {
    const since = req.query.since ? Number(req.query.since) : 0;
    const result = await syncService.getChangesSince(since);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Process Outbox Sync Batch from Client (Idempotent & Transactional)
apiRouter.post('/sync', async (req, res, next) => {
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

// Mount router under /api
app.use('/api', apiRouter);

// Top-level aliases for root backward compatibility
app.get('/health', (req, res) => res.redirect(307, '/api/health'));
app.get('/getCbuRates', ratesHandler);
app.get('/getCbuHistory', historyHandler);

// Root route
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'SalesTrack Backend API',
    status: 'running',
    docs: '/api/health'
  });
});

// 6. 404 Not Found Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 7. Global Error Handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const statusCode = err.status || 500;
  console.error('[server error]', err.message);
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error'
  });
});

// 8. Server Start & Migration Runner
let server;

async function startServer() {
  try {
    // Run automated migrations before listening for traffic
    await db.runMigrations();
    console.log('[SalesTrack Backend] Database migrations up to date.');

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
