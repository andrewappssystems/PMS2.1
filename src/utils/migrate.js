'use strict';
/**
 * src/utils/migrate.js
 *
 * Auto-migration: runs ALTER TABLE IF NOT EXISTS statements on every startup.
 * All statements are idempotent (safe to re-run many times).
 * Failures are logged but never crash the server.
 */
const pool = require('../../database/pool');

const migrations = [
  // ── Archive table — enterprise audit columns ───────────────────────────
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS module          VARCHAR(50)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS action          VARCHAR(50)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS description     TEXT`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS old_values      JSONB`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS new_values      JSONB`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS severity        VARCHAR(20) DEFAULT 'INFO'`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS log_status      VARCHAR(20) DEFAULT 'SUCCESS'`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS ip_address      VARCHAR(100)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS user_agent      TEXT`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS session_id      VARCHAR(200)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS route           VARCHAR(200)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS ref_tenant_id   VARCHAR(20)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS ref_landlord_id VARCHAR(20)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS ref_property_id VARCHAR(20)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS reference_number VARCHAR(50)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS user_role       VARCHAR(50)`,
  `ALTER TABLE archive ADD COLUMN IF NOT EXISTS metadata        JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_archive_severity   ON archive(severity)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_action     ON archive(action)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_module     ON archive(module)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_log_status ON archive(log_status)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_deleted_at ON archive(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_deleted_by ON archive(deleted_by)`,

  // ── Landlords — management flat fee ───────────────────────────────────
  `ALTER TABLE landlords ADD COLUMN IF NOT EXISTS management_flat_fee NUMERIC(12,2) DEFAULT 0`,

  // ── Invoices — status column ───────────────────────────────────────────
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Unpaid'`,

  // ── Receipts — tenant/property link for deposit income reporting ───────
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tenant_id   VARCHAR(20)`,
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS property_id VARCHAR(20)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_tenant   ON receipts(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_property ON receipts(property_id)`,

  // ── Rent balances — last charge tracking ──────────────────────────────
  `ALTER TABLE rent_balances ADD COLUMN IF NOT EXISTS last_charge_month VARCHAR(7)`,
];

async function runMigrations() {
  let ok = 0, fail = 0;
  for (const sql of migrations) {
    try {
      await pool.query(sql);
      ok++;
    } catch (e) {
      // Only log real errors — index-already-exists is harmless
      if (!e.message.includes('already exists')) {
        console.warn('[migrate]', e.message.split('\n')[0]);
        fail++;
      } else {
        ok++;
      }
    }
  }
  console.log(`[migrate] Done — ${ok} OK, ${fail} failed`);
}

module.exports = runMigrations;
