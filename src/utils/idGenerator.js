'use strict';
const pool = require('../../database/pool');

async function getNextId(table, idColumn, prefix) {
  const { rows } = await pool.query(`SELECT ${idColumn} FROM ${table} ORDER BY id DESC LIMIT 1`);
  if (!rows.length) return `${prefix}-001`;
  const match = String(rows[0][idColumn] || '').match(/(\d+)$/);
  return `${prefix}-${String(match ? parseInt(match[1]) + 1 : 1).padStart(3, '0')}`;
}

async function getNextYearId(table, idColumn, prefix) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT ${idColumn} FROM ${table} WHERE ${idColumn} LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`${prefix}-${year}-%`]
  );
  if (!rows.length) return `${prefix}-${year}-001`;
  const last = rows[0][idColumn] || '';
  const match = last.match(/(\d+)$/);
  const next = match ? parseInt(match[1]) + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(3, '0')}`;
}

module.exports = { getNextId, getNextYearId };
