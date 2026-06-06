-- ═════════════════════════════════════════════════════════════════════════════
-- ManageMate PMS — Complete Database Schema v2
-- PostgreSQL 12+, Neon Free Tier (5 concurrent connections)
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           VARCHAR(20)  PRIMARY KEY,
  username     VARCHAR(100) UNIQUE NOT NULL,
  password     VARCHAR(255) NOT NULL,
  full_name    VARCHAR(200) NOT NULL,
  email        VARCHAR(200),
  role         VARCHAR(50)  DEFAULT 'Staff',
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);

-- ─────────────────────────────────────────────────────────────────────────────
-- LANDLORDS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landlords (
  id                 VARCHAR(20) PRIMARY KEY,
  name               VARCHAR(200) NOT NULL,
  phone              VARCHAR(50),
  email              VARCHAR(200),
  address            TEXT,
  bank_name          VARCHAR(200),
  bank_account       VARCHAR(100),
  commission_rate    NUMERIC(5,2) DEFAULT 0,
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_landlords_name ON landlords(name);
CREATE INDEX IF NOT EXISTS idx_landlords_phone ON landlords(phone);

-- ─────────────────────────────────────────────────────────────────────────────
-- PROPERTIES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id           VARCHAR(20)  PRIMARY KEY,
  landlord_id  VARCHAR(20)  NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  address      TEXT,
  type         VARCHAR(100),
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties(landlord_id);
CREATE INDEX IF NOT EXISTS idx_properties_name ON properties(name);

-- ─────────────────────────────────────────────────────────────────────────────
-- UNITS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id            VARCHAR(20)  PRIMARY KEY,
  property_id   VARCHAR(20)  NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_number   VARCHAR(100) NOT NULL,
  type          VARCHAR(100),
  rent          NUMERIC(15,2) DEFAULT 0,
  description   TEXT,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_units_number ON units(unit_number);

-- ─────────────────────────────────────────────────────────────────────────────
-- TENANTS TABLE (with new emergency & next-of-kin fields)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                   VARCHAR(20)   PRIMARY KEY,
  name                 VARCHAR(200)  NOT NULL,
  phone                VARCHAR(50),
  email                VARCHAR(200),
  id_number            VARCHAR(100),
  unit_id              VARCHAR(20)   REFERENCES units(id) ON DELETE SET NULL,
  lease_start          DATE,
  lease_end            DATE,
  rent_amount          NUMERIC(15,2) DEFAULT 0,
  deposit              NUMERIC(15,2) DEFAULT 0,
  status               VARCHAR(50)   DEFAULT 'Active',
  emergency_name       VARCHAR(200),
  emergency_phone      VARCHAR(50),
  next_of_kin_name     VARCHAR(200),
  next_of_kin_phone    VARCHAR(50),
  next_of_kin_rel      VARCHAR(100),
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenants_name ON tenants(name);
CREATE INDEX IF NOT EXISTS idx_tenants_unit ON tenants(unit_id);
CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- RENT COLLECTION TABLE (with partial payment tracking)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_collection (
  id                 VARCHAR(20)   PRIMARY KEY,
  tenant_id          VARCHAR(20)   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id            VARCHAR(20)   REFERENCES units(id) ON DELETE SET NULL,
  amount             NUMERIC(15,2) NOT NULL,
  expected_amount    NUMERIC(15,2) DEFAULT 0,
  month              INTEGER NOT NULL,
  year               INTEGER NOT NULL,
  payment_method     VARCHAR(100),
  reference          VARCHAR(100),
  payment_type       VARCHAR(20)   DEFAULT 'Full',
  balance_before     NUMERIC(15,2) DEFAULT 0,
  balance_after      NUMERIC(15,2) DEFAULT 0,
  collected_at       TIMESTAMPTZ   DEFAULT NOW(),
  created_by         VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_rent_tenant ON rent_collection(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rent_date ON rent_collection(year, month);
CREATE INDEX IF NOT EXISTS idx_rent_payment ON rent_collection(collected_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- EXPENSES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id             VARCHAR(20)   PRIMARY KEY,
  property_id    VARCHAR(20)   REFERENCES properties(id) ON DELETE SET NULL,
  category       VARCHAR(100),
  description    TEXT,
  amount         NUMERIC(15,2) NOT NULL,
  expense_date   DATE,
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  created_by     VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- INVOICES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id             VARCHAR(20)   PRIMARY KEY,
  type           VARCHAR(50) NOT NULL,
  entity_id      VARCHAR(20),
  entity_name    VARCHAR(200),
  description    TEXT,
  amount         NUMERIC(15,2) NOT NULL,
  month          INTEGER,
  year           INTEGER,
  qr_code        BYTEA,
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  created_by     VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
CREATE INDEX IF NOT EXISTS idx_invoices_entity ON invoices(entity_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(year, month);

-- ─────────────────────────────────────────────────────────────────────────────
-- RECEIPTS TABLE (with balance tracking)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
  id               VARCHAR(20)   PRIMARY KEY,
  rent_id          VARCHAR(20)   REFERENCES rent_collection(id) ON DELETE SET NULL,
  tenant_name      VARCHAR(200),
  unit_number      VARCHAR(100),
  amount           NUMERIC(15,2) NOT NULL,
  expected_amount  NUMERIC(15,2) DEFAULT 0,
  month            INTEGER,
  year             INTEGER,
  payment_method   VARCHAR(100),
  payment_type     VARCHAR(20)   DEFAULT 'Full',
  balance_carried  NUMERIC(15,2) DEFAULT 0,
  qr_code          BYTEA,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  created_by       VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_receipts_rent ON receipts(rent_id);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(year, month);

-- ─────────────────────────────────────────────────────────────────────────────
-- SETTINGS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id               SERIAL PRIMARY KEY,
  key              VARCHAR(100) UNIQUE NOT NULL,
  value            TEXT,
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

-- ─────────────────────────────────────────────────────────────────────────────
-- RENT BALANCES TABLE (running balance per tenant)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_balances (
  tenant_id       VARCHAR(20) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  carried_balance NUMERIC(15,2) DEFAULT 0,
  last_updated    TIMESTAMPTZ   DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RENT INCREASE HISTORY TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_increase_history (
  id             SERIAL PRIMARY KEY,
  increase_id    VARCHAR(20) UNIQUE,
  unit_id        VARCHAR(20)   REFERENCES units(id) ON DELETE SET NULL,
  tenant_id      VARCHAR(20)   REFERENCES tenants(id) ON DELETE SET NULL,
  old_rent       NUMERIC(15,2),
  new_rent       NUMERIC(15,2),
  effective_date DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  created_by     VARCHAR(200)
);
CREATE INDEX IF NOT EXISTS idx_rent_increase_unit ON rent_increase_history(unit_id);
CREATE INDEX IF NOT EXISTS idx_rent_increase_date ON rent_increase_history(effective_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- ARCHIVE TABLE (universal soft delete / audit trail)
-- ─────────────────────────────────────────────────────────────────────────────
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
CREATE INDEX IF NOT EXISTS idx_archive_id    ON archive(entity_id);
CREATE INDEX IF NOT EXISTS idx_archive_label ON archive(entity_label);
CREATE INDEX IF NOT EXISTS idx_archive_date  ON archive(deleted_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATIONS TABLE (for document code verification)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verifications (
  code        VARCHAR(32) PRIMARY KEY,
  doc_id      VARCHAR(200) NOT NULL,
  doc_type    VARCHAR(50),
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verifications_doc_id   ON verifications(doc_id);
CREATE INDEX IF NOT EXISTS idx_verifications_doc_type ON verifications(doc_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- SESSION TABLE (Express session store — auto-managed by express-session)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  sid      VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess     JSON NOT NULL,
  expire   TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- ═════════════════════════════════════════════════════════════════════════════
-- Schema initialization complete. All tables created successfully.
-- ═════════════════════════════════════════════════════════════════════════════