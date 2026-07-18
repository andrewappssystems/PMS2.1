'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCachePrefix } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId, getNextYearId } = require('../utils/idGenerator');
const { getPagination, pageResp } = require('../utils/pagination');
const { makeVerifyQR } = require('../utils/verification');

exports.list = async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const key = `receipts_p${page}_l${limit}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT receipt_id AS "ID", rent_id AS "Rent ID",
               tenant_name AS "TenantName", unit_number AS "UnitNumber",
               amount AS "Amount", month AS "Month", year AS "Year",
               payment_method AS "PaymentMethod",
               TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS "Date", created_by AS "Added By"
        FROM receipts ORDER BY id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM receipts')
    ]);
    const result = pageResp(data.rows, count.rows[0].count, page, limit);
    setCache(key, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['tenantName','Tenant name'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rentId='', tenantName, unitNumber='', amount, month='', year='', paymentMethod='Cash' } = req.body;
    const id = await getNextId('receipts', 'receipt_id', 'RCP');
    await pool.query(
      `INSERT INTO receipts (receipt_id,rent_id,tenant_name,unit_number,amount,month,year,payment_method,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, rentId||null, tenantName.trim(), unitNumber.trim(), parseFloat(amount), month, year?parseInt(year):null, paymentMethod, actor(req)]
    );
    clearCachePrefix('receipts_');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/receipts]', e.message); res.status(500).json({ error: e.message }); }
};

exports.createV2 = async (req, res) => {
  const err = validate([['tenantName','Tenant name'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const {
      rentId='', tenantName, unitNumber='', amount,
      month='', year='', paymentMethod='Cash',
      paymentType='Full', balanceCarried=0, expectedAmount=0
    } = req.body;
    const id = await getNextYearId('receipts', 'receipt_id', 'RCP');
    await pool.query(
      `INSERT INTO receipts
       (receipt_id,rent_id,tenant_name,unit_number,amount,month,year,
        payment_method,payment_type,balance_carried,expected_amount,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, rentId||null, tenantName.trim(), unitNumber.trim(),
       parseFloat(amount), month,
       year ? parseInt(year) : null,
       paymentMethod,
       paymentType,
       parseFloat(balanceCarried)||0,
       parseFloat(expectedAmount)||0,
       actor(req)]
    );
    clearCachePrefix('receipts_');
    res.json({ success: true, id });
  } catch (e) {
    console.error('[POST /api/receipts/v2]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getPdf = async (req, res) => {
  try {
    const [{ rows:rcpRows }, { rows:sRows }] = await Promise.all([
      pool.query(`SELECT * FROM receipts WHERE receipt_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!rcpRows.length) return res.status(404).send('Receipt not found');
    const r = rcpRows[0];
    const cfg = {}; sRows.forEach(s => { cfg[s.key]=s.value; });
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(r.receipt_id, 'RCP', req);
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo.startsWith('http') ? '' : '/'}${cfg.company_logo.replace(/^\/+/, '')}" style="height:44px;object-fit:contain">` : '';
    const balCarried = parseFloat(r.balance_carried||0);
    const expected  = parseFloat(r.expected_amount||0);
    const paid      = parseFloat(r.amount||0);
    const balAfter  = expected > 0 ? Math.max(0, expected - paid + balCarried) : 0;
    const fmt = n => (cfg.currency||'UGX') + ' ' + Number(n||0).toLocaleString();
    const host = `${req.protocol}://${req.get('host')}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${r.receipt_id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;color:#1e293b;font-size:13px}
.wrap{max-width:580px;margin:0 auto;padding:40px}
.receipt{border:2px solid #0f766e;border-radius:12px;padding:36px}
.hdr{text-align:center;border-bottom:2px dashed #0f766e;padding-bottom:18px;margin-bottom:22px}
.hdr .logo-row{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px}
.hdr h1{color:#0f766e;font-size:24px;margin-bottom:4px}
.stamp{display:inline-block;background:#0f766e;color:#fff;padding:6px 22px;border-radius:20px;font-weight:700;margin:6px 0}
.hdr small{color:#64748b;font-size:12px}
.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #e2e8f0}
.lbl{color:#64748b;font-weight:600;font-size:12px}
.val{font-weight:600;font-size:13px}
.amt-box{background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:18px;text-align:center;margin:20px 0}
.amt-box .lbl{color:#166534;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.amt-box .val{color:#0f766e;font-size:30px;font-weight:700;margin-top:4px}
.bal-box{background:#fff7ed;border:1px solid #f59e0b;border-radius:8px;padding:12px;text-align:center;margin-bottom:16px}
.verify{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;display:flex;align-items:center;justify-content:space-between;margin-top:16px}
.code{font-family:monospace;font-size:14px;font-weight:700;color:#0f766e;letter-spacing:2px}
.footer{text-align:center;margin-top:20px;color:#94a3b8;font-size:11px}
@media print{.no-print{display:none!important}body{font-size:12px}.wrap{padding:20px}}
</style></head><body>
<div class="wrap"><div class="receipt">
  <div class="hdr">
    <div class="logo-row">${logoHtml}<strong style="font-size:15px">${cfg.company_name||'Property Management'}</strong></div>
    <h1>RENT RECEIPT</h1>
    <div class="stamp">✔ PAID</div>
    <div><small>Receipt No: <strong>${r.receipt_id}</strong> &nbsp;|&nbsp; ${new Date(r.created_at).toLocaleDateString('en-GB')}</small></div>
  </div>
  <div class="row"><span class="lbl">Received From</span><span class="val">${r.tenant_name||'N/A'}</span></div>
  <div class="row"><span class="lbl">Unit</span><span class="val">${r.unit_number||'N/A'}</span></div>
  <div class="row"><span class="lbl">Period</span><span class="val">${r.month||''} ${r.year||''}</span></div>
  <div class="row"><span class="lbl">Payment Method</span><span class="val">${r.payment_method||'Cash'}</span></div>
  <div class="row"><span class="lbl">Payment Type</span><span class="val">${r.payment_type||'Full'}</span></div>
  ${expected>0?`<div class="row"><span class="lbl">Expected This Month</span><span class="val">${fmt(expected)}</span></div>`:''}
  ${balCarried>0?`<div class="row"><span class="lbl">Balance Carried Forward</span><span class="val" style="color:#dc2626">${fmt(balCarried)}</span></div>`:''}
  <div class="amt-box">
    <div class="lbl">Amount Received</div>
    <div class="val">${fmt(r.amount)}</div>
  </div>
  ${balAfter>0?`<div class="bal-box"><strong style="color:#92400e">⚠️ Outstanding Balance: ${fmt(balAfter)}</strong><br><small style="color:#92400e">This amount will be carried to the next payment period.</small></div>`:''}
  <div class="verify">
   <div class="verify" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:12px">
  <div style="flex:1">
    <strong style="font-size:11px;color:#374151">Document Verification</strong>
    <div style="font-size:10px;color:#94a3b8;margin-top:2px">Scan QR or visit link to verify authenticity</div>
    <div style="font-size:10px;margin-top:3px"><a href="${verifyUrl}" style="color:#0f766e;word-break:break-all">${verifyUrl}</a></div>
    <div style="font-family:monospace;font-size:13px;font-weight:700;color:#0f766e;letter-spacing:2px;margin-top:4px">${verifyCode}</div>
  </div>
  <div style="flex-shrink:0;text-align:center">
    <img src="${qrDataUrl}" style="width:72px;height:72px;display:block">
    <div style="font-size:10px;color:#94a3b8;margin-top:2px">Scan to verify</div>
  </div>
</div>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e) { console.error('[receipt pdf]',e.message); res.status(500).send('Error: '+e.message); }
};
