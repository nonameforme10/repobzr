/**
 * SalesTrack — VPS Backend Server
 * Production-ready Express API with Helmet, Rate Limiting, Strict CORS,
 * and canonical /api routing.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cbuService = require('./services/cbu');

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// 1. Security Headers
app.use(helmet());

// 2. Request Body Parsing with Strict Limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 3. Strict CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server requests, curl, or when no origin header is provided
    if (!origin) return callback(null, true);

    // If wildcard or no specific origins defined in development, allow all
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin '${origin}' not allowed by CORS`));
  },
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};

app.use(cors(corsOptions));

// 4. Rate Limiting for API routes (120 requests per 15 min per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});

// 5. Canonical /api Router
const apiRouter = express.Router();
apiRouter.use(limiter);

// Health check endpoint
apiRouter.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
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
  const statusCode = err.status || 502;
  console.error('[server error]', err.message);
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error'
  });
});

// 8. Server Start & Graceful Shutdown
const server = app.listen(PORT, () => {
  console.log(`[SalesTrack Backend] Listening on port ${PORT} (${NODE_ENV})`);
});

function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  // Force close after 10s if hanging
  setTimeout(() => {
    console.error('Forcefully exiting after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app, server };
