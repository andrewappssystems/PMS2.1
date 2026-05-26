-- ─────────────────────────────────────────────────────────────────────────────
-- PMS Schema v2 — Run in Neon SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- Tenant extra fields
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_name     VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_phone    VARCHAR(50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_name  VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_phone VARCHAR(50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_rel   VARCHAR(100);

-- Partial payment tracking on rent_collection
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS payment_type   VARCHAR(20)   DEFAULT 'Full';
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS balance_before NUMERIC(15,2) DEFAULT 0;
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS balance_after  NUMERIC(15,2) DEFAULT 0;
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(15,2) DEFAULT 0;

-- Balance on receipts
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_type    VARCHAR(20)   DEFAULT 'Full';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS balance_carried NUMERIC(15,2) DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(15,2) DEFAULT 0;

-- Running balance per tenant
CREATE TABLE IF NOT EXISTS rent_balances (
  tenant_id       VARCHAR(20) PRIMARY KEY,
  carried_balance NUMERIC(15,2) DEFAULT 0,
  last_updated    TIMESTAMPTZ   DEFAULT NOW()
);

-- Rent increase history
CREATE TABLE IF NOT EXISTS rent_increase_history (
  id             SERIAL PRIMARY KEY,
  increase_id    VARCHAR(20) UNIQUE,
  unit_id        VARCHAR(20),
  tenant_id      VARCHAR(20),
  old_rent       NUMERIC(15,2),
  new_rent       NUMERIC(15,2),
  effective_date DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  created_by     VARCHAR(200)
);

-- Universal archive for all deleted records
CREATE TABLE IF NOT EXISTS archive (
  id           SERIAL PRIMARY KEY,
  entity_type  VARCHAR(50)  NOT NULL,
  entity_id    VARCHAR(20)  NOT NULL,
  entity_label VARCHAR(200),
  data         JSONB        NOT NULL,
  deleted_at   TIMESTAMPTZ  DEFAULT NOW(),
  deleted_by   VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_archive_type  ON archive(entity_type);
CREATE INDEX IF NOT EXISTS idx_archive_label ON archive(entity_label);
CREATE INDEX IF NOT EXISTS idx_archive_date  ON archive(deleted_at);