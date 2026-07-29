'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache, clearCachePrefix } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { getPagination, pageResp } = require('../utils/pagination');
const { getTenantBalance, setTenantBalance } = require('../services/rentService');
const { getSettings } = require('../services/settingsService');
const { logEvent, logAudit } = require('../services/auditService');


exports.list = async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const key = `rent_p${page}_l${limit}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT r.rent_id AS "ID", r.tenant_id AS "Tenant ID", t.name AS "Tenant Name",
               r.unit_id AS "Unit ID", u.unit_number AS "Unit Number",
               r.amount AS "Amount", r.month AS "Month", r.year AS "Year",
               r.payment_method AS "Payment Method", r.reference AS "Reference",
               TO_CHAR(r.created_at,'YYYY-MM-DD HH24:MI') AS "Date", r.created_by AS "Added By"
        FROM rent_collection r
        LEFT JOIN tenants t ON t.tenant_id=r.tenant_id
        LEFT JOIN units   u ON u.unit_id=r.unit_id
        ORDER BY r.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM rent_collection')
    ]);
    const result = pageResp(data.rows, count.rows[0].count, page, limit);
    setCache(key, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['tenantId','Tenant'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { tenantId, unitId='', amount, month='', year='', paymentMethod='Cash', reference='' } = req.body;
    const id = await getNextId('rent_collection', 'rent_id', 'RNT');
    await pool.query(
      `INSERT INTO rent_collection (rent_id,tenant_id,unit_id,amount,month,year,payment_method,reference,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, tenantId, unitId||null, parseFloat(amount), month, year?parseInt(year):null, paymentMethod, reference.trim(), actor(req)]
    );
    clearCachePrefix('rent_'); clearCache('stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/rent]', e.message); res.status(500).json({ error: e.message }); }
};

exports.createV2 = async (req, res) => {
  const err = validate([['tenantId','Tenant'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const {
      tenantId, unitId='', amount, month='', year='',
      paymentMethod='Cash', reference='',
      paymentType='Full', expectedAmount=''
    } = req.body;

    const paid     = parseFloat(amount);
    const expected = parseFloat(expectedAmount) || paid;
    const prevBal  = await getTenantBalance(tenantId);
    const totalOwed = expected + prevBal;
    const newBal    = totalOwed - paid;
    const finalBal  = newBal; // negative = tenant credit
    const isPartial = paymentType === 'Partial' || paid < totalOwed;

    const id = await getNextId('rent_collection', 'rent_id', 'RNT');
    await pool.query(
      `INSERT INTO rent_collection
       (rent_id,tenant_id,unit_id,amount,month,year,payment_method,reference,
        payment_type,balance_before,balance_after,expected_amount,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, tenantId, unitId||null, paid, month,
       year ? parseInt(year) : null,
       paymentMethod, reference.trim(),
       isPartial ? 'Partial' : 'Full',
       prevBal, finalBal, expected, actor(req)]
    );
    await setTenantBalance(tenantId, finalBal);

    // Rich audit event
    const { rows: tRows } = await pool.query(`SELECT name, unit_id FROM tenants WHERE tenant_id=$1`, [tenantId]);
    const { rows: uRows } = tenantId && tRows.length && tRows[0].unit_id
      ? await pool.query(`SELECT unit_number FROM units WHERE unit_id=$1`, [tRows[0].unit_id])
      : { rows: [] };
    const tName  = tRows.length ? tRows[0].name : tenantId;
    const uNum   = uRows.length ? uRows[0].unit_number : (unitId || '');
    const pmtLabel = isPartial ? 'Partial Payment' : 'Full Payment';
    const cfg2 = await getSettings(false);
    const curr = cfg2.currency || 'UGX';
    await logEvent({
      action: isPartial ? 'PARTIAL_PAYMENT' : 'PAYMENT',
      module: 'rent',
      entityType: 'rent',
      entityId: id,
      description: `${actor(req)} recorded ${pmtLabel} of ${curr} ${Number(paid).toLocaleString()} for ${tName}${uNum?' (Unit '+uNum+')':''} — Period: ${month}/${year}. Balance after: ${curr} ${Number(finalBal).toLocaleString()}.`,
      oldValues: { balance: prevBal },
      newValues: { balance: finalBal, amountPaid: paid, period: `${month}/${year}` },
      severity: isPartial ? 'WARNING' : 'INFO',
      status: 'SUCCESS',
      req,
      tenantId,
      referenceNumber: id,
      metadata: { paymentMethod, reference, paymentType: isPartial?'Partial':'Full' }
    });

    clearCachePrefix('rent_'); clearCache('stats');
    res.json({ success: true, id, balanceBefore: prevBal, balanceAfter: finalBal, isPartial });
  } catch (e) {
    console.error('[POST /api/rent/v2]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getDueStatus = async (req, res) => {
  try {
    const { syncLedgers } = require('../services/rentService');
    await syncLedgers();

    const now        = new Date();
    const dayOfMonth = now.getDate();

    const { rows: activeTenants } = await pool.query(
      `SELECT t.tenant_id, t.name, t.rent_amount,
              u.unit_number, p.name AS property_name,
              COALESCE(rb.carried_balance, 0) as carried_balance
       FROM tenants t
       LEFT JOIN units u ON u.unit_id = t.unit_id
       LEFT JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN rent_balances rb ON rb.tenant_id = t.tenant_id
       WHERE LOWER(t.status)='active' AND t.rent_amount > 0`
    );

    let totalUnpaid = 0;
    let overdueCount = 0;
    const unpaidTenants = [];

    activeTenants.forEach(t => {
      const bal  = parseFloat(t.carried_balance);
      const rent = parseFloat(t.rent_amount);

      // Negative balance = credit (paid ahead) — not in arrears
      if (bal <= 0) return;

      // Before the 5th: current month charge not yet due.
      // Show only genuine past-month arrears.
      const genuineArrears = dayOfMonth < 5 ? Math.max(0, bal - rent) : bal;
      if (genuineArrears <= 0) return;

      // Calculate months overdue (floored) for severity
      const monthsOverdue = rent > 0 ? Math.floor(genuineArrears / rent) : 0;
      const severity = monthsOverdue >= 3 ? 'Critical'
                     : monthsOverdue >= 1 ? 'Overdue'
                     : 'Watch';

      totalUnpaid++;
      overdueCount++;
      unpaidTenants.push({
        id:             t.tenant_id,
        name:           t.name,
        unit:           t.unit_number,
        property:       t.property_name,
        rent:           rent,
        carriedBalance: bal,
        overdueBalance: genuineArrears,
        monthsOverdue,
        severity
      });
    });

    // Sort: Critical first, then by balance descending
    unpaidTenants.sort((a, b) => {
      const sevOrder = { Critical: 0, Overdue: 1, Watch: 2 };
      if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
      return b.overdueBalance - a.overdueBalance;
    });

    res.json({
      dayOfMonth,
      dueToday:     dayOfMonth === 5,
      totalUnpaid,
      overdueCount,
      unpaidTenants
    });
  } catch (e) {
    console.error('[/api/rent/due-status]', e.message);
    res.status(500).json({ error: e.message });
  }
};


exports.generateWhatsApp = async (req, res) => {
  try {
    const { receiptId } = req.body;
    const cfg = await getSettings(false);
    const company = cfg.company_name || 'Property Management';

    let msg = '';
    if (receiptId) {
      const { rows } = await pool.query(
        `SELECT r.*, rc.balance_after, rc.balance_before, rc.payment_type, rc.expected_amount
         FROM receipts r
         LEFT JOIN rent_collection rc ON rc.rent_id = r.rent_id
         WHERE r.receipt_id = $1`, [receiptId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Receipt not found' });
      const r = rows[0];
      const balAfter = parseFloat(r.balance_after || 0);
      const currency = cfg.currency || 'UGX';
      msg = `*${company}*\n\n`;
      msg += `✅ *Rent Payment Received*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Dear ${r.tenant_name},\n\n`;
      msg += `We confirm receipt of your rent payment:\n\n`;
      msg += `📋 Receipt No: *${r.receipt_id}*\n`;
      msg += `🏠 Unit: *${r.unit_number}*\n`;
      msg += `📅 Period: *${r.month} ${r.year}*\n`;
      msg += `💰 Amount Paid: *${currency} ${Number(r.amount).toLocaleString()}*\n`;
      msg += `💳 Method: *${r.payment_method}*\n`;
      msg += `📆 Date: *${new Date(r.created_at).toLocaleDateString('en-GB')}*\n`;
      if (balAfter > 0) {
        msg += `\n⚠️ *Outstanding Balance: ${currency} ${balAfter.toLocaleString()}*\n`;
        msg += `Please settle this balance as soon as possible.\n`;
      } else {
        msg += `\n✅ Your account is fully up to date.\n`;
      }
      msg += `\nThank you for your payment.\n_${company}_`;
    }
    res.json({ success: true, message: msg });
  } catch (e) {
    console.error('[whatsapp-message]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.createIncrease = async (req, res) => {
  const err = validate([['unitId','Unit'],['newRent','New rent'],['effectiveDate','Effective date']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { unitId, newRent, effectiveDate, notes='' } = req.body;
    const { rows: unitRows } = await pool.query(
      `SELECT unit_id, rent FROM units WHERE unit_id=$1`, [unitId]
    );
    if (!unitRows.length) return res.status(404).json({ error: 'Unit not found' });
    const oldRent = parseFloat(unitRows[0].rent);
    const nr      = parseFloat(newRent);

    const { rows: tenantRows } = await pool.query(
      `SELECT tenant_id FROM tenants WHERE unit_id=$1 AND LOWER(status)='active'`, [unitId]
    );
    const tenantId = tenantRows.length ? tenantRows[0].tenant_id : null;

    const hid = await getNextId('rent_increase_history', 'increase_id', 'RNI');
    await pool.query(
      `INSERT INTO rent_increase_history
       (increase_id,unit_id,tenant_id,old_rent,new_rent,effective_date,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [hid, unitId, tenantId, oldRent, nr, effectiveDate, notes.trim(), actor(req)]
    );

    const effDate = new Date(effectiveDate);
    const today   = new Date();
    today.setHours(0,0,0,0);
    if (effDate <= today) {
      await pool.query(`UPDATE units SET rent=$1 WHERE unit_id=$2`, [nr, unitId]);
      if (tenantId) {
        await pool.query(`UPDATE tenants SET rent_amount=$1 WHERE tenant_id=$2`, [nr, tenantId]);
      }
      clearCache('units','tenants','properties','stats');
    }

    res.json({ success: true, id: hid, applied: effDate <= today });
  } catch (e) {
    console.error('[POST /api/rent-increase]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getIncreaseHistory = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.increase_id, h.unit_id, u.unit_number,
             p.name AS property_name,
             h.tenant_id, t.name AS tenant_name,
             h.old_rent, h.new_rent, h.effective_date, h.notes,
             TO_CHAR(h.created_at,'YYYY-MM-DD') AS created_at, h.created_by
      FROM rent_increase_history h
      LEFT JOIN units u ON u.unit_id = h.unit_id
      LEFT JOIN properties p ON p.property_id = u.property_id
      LEFT JOIN tenants t ON t.tenant_id = h.tenant_id
      ORDER BY h.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
