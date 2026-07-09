'use strict';
const pool = require('../../database/pool');

async function getTenantBalance(tenantId) {
  const { rows } = await pool.query(
    `SELECT carried_balance FROM rent_balances WHERE tenant_id=$1`, [tenantId]
  );
  return rows.length ? parseFloat(rows[0].carried_balance) : 0;
}

async function setTenantBalance(tenantId, balance) {
  await pool.query(
    `INSERT INTO rent_balances (tenant_id, carried_balance, last_updated)
     VALUES ($1,$2,NOW())
     ON CONFLICT (tenant_id) DO UPDATE
     SET carried_balance=EXCLUDED.carried_balance, last_updated=NOW()`,
    [tenantId, balance]
  );
}

module.exports = { getTenantBalance, setTenantBalance };
