'use strict';
const { Pool } = require('pg');
const { isProduction, DATABASE_URL } = require('../src/config/env');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
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
