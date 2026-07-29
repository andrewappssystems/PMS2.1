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

/**
 * syncLedgers — Called each time arrears are checked.
 *
 * Rules:
 * 1. Only runs on or after the 5th of the month.
 * 2. Only injects a CHARGE once per tenant per calendar month.
 * 3. If a tenant has a CREDIT (balance < 0), the charge reduces the credit.
 *    They appear in arrears ONLY if balance ends up > 0 after the charge.
 * 4. Tracks last_charge_month so we never double-charge.
 */
async function syncLedgers() {
  const now = new Date();
  const dayOfMonth = now.getDate();

  // Per business rules: charges become due on the 5th
  if (dayOfMonth < 5) return;

  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = now.getFullYear();
  const chargeMonthKey = `${y}-${m}`;

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
      const currentBal = await getTenantBalance(t.tenant_id);
      const rent = parseFloat(t.rent_amount);
      const newBal = currentBal + rent; // adds charge; if was credit (negative), reduces it
      const id = 'CHG-' + Date.now() + Math.floor(Math.random()*1000);

      await pool.query(
        `INSERT INTO rent_collection
         (rent_id, tenant_id, unit_id, amount, expected_amount, month, year, payment_method, payment_type, balance_before, balance_after, created_by)
         VALUES ($1,$2,$3,0,$4,$5,$6,'System','Charge',$7,$8,'System')`,
        [id, t.tenant_id, t.unit_id, rent, m, y, currentBal, newBal]
      );
      await setTenantBalance(t.tenant_id, newBal);
    }
  }
}

/**
 * Initialise a tenant's balance at onboarding.
 *
 * @param {string} tenantId
 * @param {number} rentAmount   - Monthly rent
 * @param {number} advanceMonths - How many months paid in advance (0 = none)
 * @param {number} partialPaid   - Amount paid if partial (0 = none)
 */
async function initTenantBalance(tenantId, rentAmount, advanceMonths = 0, partialPaid = 0) {
  const rent = parseFloat(rentAmount) || 0;
  const adv  = parseInt(advanceMonths) || 0;
  const paid = parseFloat(partialPaid) || 0;

  let initialBalance = 0;

  if (adv > 0) {
    // Credit: negative balance means they're paid ahead
    initialBalance = -(adv * rent);
  } else if (paid > 0 && paid < rent) {
    // Partial payment: they owe the remainder
    initialBalance = rent - paid;
  } else if (paid >= rent) {
    // Full month paid, they're clear for this month
    initialBalance = 0;
  }

  if (initialBalance !== 0 || adv > 0 || paid > 0) {
    await setTenantBalance(tenantId, initialBalance);
  }
}

module.exports = { getTenantBalance, setTenantBalance, syncLedgers, initTenantBalance };
