'use strict';
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 3,                      // Neon free = max 5 connections, keep headroom
  idleTimeoutMillis: 30000,    // Release idle connections after 30s
  connectionTimeoutMillis: 5000 // Fail fast if DB unreachable
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Startup health check
pool.query('SELECT 1')
  .then(() => console.log('[DB] PostgreSQL connected'))
  .catch(err => {
    console.error('[DB] Connection failed:', err.message);
    if (isProduction) process.exit(1);
  });

module.exports = pool;
