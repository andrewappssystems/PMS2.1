-- ═════════════════════════════════════════════════════════════════════════════
-- ManageMate PMS — Migration v2 (Add Emergency & Next-of-Kin Fields)
-- ═════════════════════════════════════════════════════════════════════════════
-- Run this on existing databases to add new columns without dropping data.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ADD EMERGENCY CONTACT & NEXT-OF-KIN FIELDS TO TENANTS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_name     VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_phone    VARCHAR(50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_name   VARCHAR(200);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_phone  VARCHAR(50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_of_kin_rel    VARCHAR(100);

-- ─────────────────────────────────────────────────────────────────────────────
-- ADD PARTIAL PAYMENT TRACKING TO RENT COLLECTION
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS payment_type   VARCHAR(20)   DEFAULT 'Full';
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS balance_before NUMERIC(15,2) DEFAULT 0;
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS balance_after  NUMERIC(15,2) DEFAULT 0;
ALTER TABLE rent_collection ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(15,2) DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADD BALANCE TRACKING TO RECEIPTS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_type    VARCHAR(20)   DEFAULT 'Full';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS balance_carried NUMERIC(15,2) DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS expected_amount NUMERIC(15,2) DEFAULT 0;

-- ═════════════════════════════════════════════════════════════════════════════
-- Migration v2 complete. All new fields are in place.
-- ═════════════════════════════════════════════════════════════════════════════
