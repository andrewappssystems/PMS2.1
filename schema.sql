-- ─────────────────────────────────────────────────────────────────────────────
-- PMS — PostgreSQL Schema
-- Run this once in your Neon SQL editor after creating the database
-- ─────────────────────────────────────────────────────────────────────────────

-- Users
CREATE TABLE IF NOT EXISTS users (
    id          SERIAL,
    user_id     VARCHAR(20)  PRIMARY KEY,
    username    VARCHAR(100) UNIQUE NOT NULL,
    full_name   VARCHAR(200),
    email       VARCHAR(200),
    role        VARCHAR(50)  DEFAULT 'User',
    password_hash TEXT,
    status      VARCHAR(20)  DEFAULT 'Active',
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    created_by  VARCHAR(200)
);

-- Landlords
CREATE TABLE IF NOT EXISTS landlords (
    id              SERIAL,
    landlord_id     VARCHAR(20)    PRIMARY KEY,
    name            VARCHAR(200)   NOT NULL,
    phone           VARCHAR(50),
    email           VARCHAR(200),
    address         TEXT,
    bank_name       VARCHAR(200),
    bank_account    VARCHAR(100),
    commission_rate NUMERIC(5,2)   DEFAULT 10,
    status          VARCHAR(20)    DEFAULT 'Active',
    created_at      TIMESTAMPTZ    DEFAULT NOW(),
    created_by      VARCHAR(200)
);

-- Properties
CREATE TABLE IF NOT EXISTS properties (
    id          SERIAL,
    property_id VARCHAR(20)  PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    landlord_id VARCHAR(20)  REFERENCES landlords(landlord_id),
    address     TEXT,
    type        VARCHAR(50)  DEFAULT 'Residential',
    status      VARCHAR(20)  DEFAULT 'Active',
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    created_by  VARCHAR(200)
);

-- Units
CREATE TABLE IF NOT EXISTS units (
    id          SERIAL,
    unit_id     VARCHAR(20)  PRIMARY KEY,
    property_id VARCHAR(20)  REFERENCES properties(property_id),
    unit_number VARCHAR(50)  NOT NULL,
    type        VARCHAR(50)  DEFAULT 'Studio',
    rent        NUMERIC(15,2) DEFAULT 0,
    description TEXT,
    status      VARCHAR(20)  DEFAULT 'Vacant',
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    created_by  VARCHAR(200)
);

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
    id          SERIAL,
    tenant_id   VARCHAR(20)  PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    phone       VARCHAR(50),
    email       VARCHAR(200),
    id_number   VARCHAR(100),
    unit_id     VARCHAR(20)  REFERENCES units(unit_id),
    lease_start DATE,
    lease_end   DATE,
    rent_amount NUMERIC(15,2) DEFAULT 0,
    deposit     NUMERIC(15,2) DEFAULT 0,
    status      VARCHAR(20)  DEFAULT 'Active',
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    created_by  VARCHAR(200)
);

-- Rent Collection
CREATE TABLE IF NOT EXISTS rent_collection (
    id             SERIAL,
    rent_id        VARCHAR(20)  PRIMARY KEY,
    tenant_id      VARCHAR(20)  REFERENCES tenants(tenant_id),
    unit_id        VARCHAR(20)  REFERENCES units(unit_id),
    amount         NUMERIC(15,2) NOT NULL,
    month          VARCHAR(10),
    year           INTEGER,
    payment_method VARCHAR(50)  DEFAULT 'Cash',
    reference      VARCHAR(200),
    created_at     TIMESTAMPTZ  DEFAULT NOW(),
    created_by     VARCHAR(200)
);

-- Expenses
CREATE TABLE IF NOT EXISTS expenses (
    id           SERIAL,
    expense_id   VARCHAR(20)  PRIMARY KEY,
    property_id  VARCHAR(20)  REFERENCES properties(property_id),
    category     VARCHAR(100) DEFAULT 'Other',
    description  TEXT         NOT NULL,
    amount       NUMERIC(15,2) NOT NULL,
    expense_date DATE,
    created_at   TIMESTAMPTZ  DEFAULT NOW(),
    created_by   VARCHAR(200)
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
    id          SERIAL,
    invoice_id  VARCHAR(20)  PRIMARY KEY,
    type        VARCHAR(50),
    entity_id   VARCHAR(20),
    entity_name VARCHAR(200),
    description TEXT,
    amount      NUMERIC(15,2) DEFAULT 0,
    month       VARCHAR(10),
    year        INTEGER,
    status      VARCHAR(20)  DEFAULT 'Unpaid',
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    created_by  VARCHAR(200)
);

-- Receipts
CREATE TABLE IF NOT EXISTS receipts (
    id             SERIAL,
    receipt_id     VARCHAR(20)  PRIMARY KEY,
    rent_id        VARCHAR(20),
    tenant_name    VARCHAR(200),
    unit_number    VARCHAR(50),
    amount         NUMERIC(15,2) DEFAULT 0,
    month          VARCHAR(10),
    year           INTEGER,
    payment_method VARCHAR(50)  DEFAULT 'Cash',
    created_at     TIMESTAMPTZ  DEFAULT NOW(),
    created_by     VARCHAR(200)
);

-- Settings
CREATE TABLE IF NOT EXISTS settings (
    key   VARCHAR(100) PRIMARY KEY,
    value TEXT
);

-- Default settings
INSERT INTO settings (key, value) VALUES
  ('company_name',    'Your Company Name'),
  ('company_address', 'Kampala, Uganda'),
  ('company_phone',   '+256 700 000000'),
  ('company_email',   'info@yourcompany.com'),
  ('currency',        'UGX'),
  ('vat_rate',        '18')
ON CONFLICT (key) DO NOTHING;

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_properties_landlord ON properties(landlord_id);
CREATE INDEX IF NOT EXISTS idx_units_property      ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_tenants_unit        ON tenants(unit_id);
CREATE INDEX IF NOT EXISTS idx_rent_tenant         ON rent_collection(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rent_unit           ON rent_collection(unit_id);
CREATE INDEX IF NOT EXISTS idx_expenses_property   ON expenses(property_id);
CREATE INDEX IF NOT EXISTS idx_invoices_entity     ON invoices(entity_id);
CREATE INDEX IF NOT EXISTS idx_receipts_rent       ON receipts(rent_id);
