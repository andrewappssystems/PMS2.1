'use strict';
const { Pool } = require('pg');
const { isProduction, DATABASE_URL } = require('../src/config/env');

/**
 * Serverless-optimised PostgreSQL pool.
 *
 * Settings are deliberately conservative (max:3) because:
 *  - Neon free tier allows only 3 concurrent connections
 *  - Vercel serverless functions can spin up many instances simultaneously
 *  - allowExitOnIdle:true lets Node exit cleanly when the function finishes
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true          // Vercel: allow process to exit when idle
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Startup connectivity probe — skipped in serverless to avoid wasted connections on cold start.
// Set SKIP_DB_CHECK=true on Vercel. The first real request will validate connectivity.
if (process.env.SKIP_DB_CHECK !== 'true') {
  pool.query('SELECT 1')
    .then(() => console.log('[DB] PostgreSQL connected successfully'))
    .catch(err => {
      console.error('[DB] Connection failed on startup:', err.message);
      if (isProduction && process.env.VERCEL !== '1') process.exit(1);
    });
}

module.exports = pool;
