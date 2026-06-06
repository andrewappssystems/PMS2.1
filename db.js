'use strict';
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 3,                       // Neon free tier = max 5; keep headroom
  idleTimeoutMillis: 30000,     // Release idle connections after 30s
  connectionTimeoutMillis: 5000 // Fail fast if DB is unreachable
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

pool.query('SELECT 1')
  .then(() => console.log('[DB] PostgreSQL connected successfully'))
  .catch(err => {
    console.error('[DB] Connection failed on startup:', err.message);
    if (isProduction) process.exit(1);
  });

module.exports = pool;
