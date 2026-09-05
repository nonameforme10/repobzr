/**
 * SalesTrack — PostgreSQL Database & Migration Engine
 * Resilient connection pooling with automated versioned migration execution.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL || 'postgres://bozor_user:bz_sec_9f8e4a1b7c3d2e0f8a6b4c2d0e1f3a5b@127.0.0.1:5432/bozor_db';

const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log unexpected idle client errors instead of crashing the process
pool.on('error', (err) => {
  console.error('[db error] Unexpected idle client error:', err.message);
});

/**
 * Execute query with connection pool
 */
const query = (text, params) => pool.query(text, params);

/**
 * Get dedicated client for transaction
 */
const getClient = () => pool.connect();

/**
 * Health check verification
 */
async function isHealthy() {
  try {
    const res = await pool.query('SELECT 1 AS ok');
    return res.rows[0]?.ok === 1;
  } catch (err) {
    console.error('[db health check failed]', err.message);
    return false;
  }
}

/**
 * Automatically apply versioned migrations from backend/migrations
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    // 1. Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `);

    // 2. Discover all SQL migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[db migrations] No migrations directory found.');
      return;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // 3. Query already applied migrations
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(rows.map(r => r.version));

    for (const file of files) {
      if (!appliedVersions.has(file)) {
        console.log(`[db migrations] Applying migration: ${file}...`);
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
            [file, Date.now()]
          );
          await client.query('COMMIT');
          console.log(`[db migrations] Successfully applied: ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[db migrations] Failed to apply ${file}:`, err.message);
          throw err;
        }
      }
    }
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  getClient,
  isHealthy,
  runMigrations
};
