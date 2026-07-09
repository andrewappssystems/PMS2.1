'use strict';
const pool = require('../../database/pool');

async function getSettings(excludeLogo = true) {
  const query = excludeLogo
    ? `SELECT key, value FROM settings WHERE key != 'company_logo'`
    : `SELECT key, value FROM settings`;
  const { rows } = await pool.query(query);
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}

module.exports = { getSettings };
