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

// Automatically injects a 'Charge' record for the current month if missing, updating the ledger
async function syncLedgers() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = now.getFullYear();

  const { rows: active } = await pool.query(
    `SELECT tenant_id, rent_amount, unit_id FROM tenants WHERE LOWER(status)='active' AND rent_amount > 0`
  );

  const { rows: charged } = await pool.query(
    `SELECT tenant_id FROM rent_collection WHERE month=$1 AND year=$2 AND payment_type='Charge'`,
    [m, y]
  );
  const chargedSet = new Set(charged.map(r => r.tenant_id));

  for (const t of active) {
    if (!chargedSet.has(t.tenant_id)) {
      // Inject charge
      const bal = await getTenantBalance(t.tenant_id);
      const newBal = bal + parseFloat(t.rent_amount);
      const id = 'RNT-' + Date.now() + Math.floor(Math.random()*1000); // simplified ID gen for internal
      
      await pool.query(
        `INSERT INTO rent_collection 
         (rent_id, tenant_id, unit_id, amount, expected_amount, month, year, payment_method, payment_type, balance_before, balance_after, created_by)
         VALUES ($1,$2,$3,0,$4,$5,$6,'System','Charge',$7,$8,'System')`,
        [id, t.tenant_id, t.unit_id, t.rent_amount, m, y, bal, newBal]
      );
      await setTenantBalance(t.tenant_id, newBal);
    }
  }
}

module.exports = { getTenantBalance, setTenantBalance, syncLedgers };
