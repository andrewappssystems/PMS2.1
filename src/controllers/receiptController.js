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
  const { paymentType = '' } = req.query;
  const key = `receipts_p${page}_l${limit}_pt${paymentType}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    // Data query: LIMIT=$1, OFFSET=$2, paymentType=$3
    const ptFilter      = paymentType ? `WHERE payment_type = $3` : '';
    const ptParams      = paymentType ? [limit, offset, paymentType] : [limit, offset];
    // Count query: no LIMIT/OFFSET — paymentType is $1
    const ptCountFilter = paymentType ? `WHERE payment_type = $1` : '';
    const ptCountParams = paymentType ? [paymentType] : [];
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT id AS "ID", rent_id AS "Rent ID",
               tenant_name AS "Tenant", unit_number AS "Unit",
               amount AS "Amount", month AS "Month", year AS "Year",
               payment_type AS "Type",
               payment_method AS "PaymentMethod",
               TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS "Date", created_by AS "Added By"
        FROM receipts ${ptFilter} ORDER BY id DESC LIMIT $1 OFFSET $2`, ptParams),
      pool.query(`SELECT COUNT(*) FROM receipts ${ptCountFilter}`, ptCountParams)
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
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo}" style="height:44px;object-fit:contain">` : `<div style="font-size:26px">🏢</div>`;
    const balCarried = parseFloat(r.balance_carried||0);
    const expected  = parseFloat(r.expected_amount||0);
    const paid      = parseFloat(r.amount||0);
    const balAfter  = expected > 0 ? Math.max(0, expected - paid + balCarried) : 0;
    const fmt = n => (cfg.currency||'UGX') + ' ' + Number(n||0).toLocaleString();
    const host = `${req.protocol}://${req.get('host')}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${r.receipt_id}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,Arial,sans-serif;color:#010101;font-size:13px;background:#FFFFFF}
.wrap{max-width:580px;margin:0 auto;padding:40px}
.receipt{border:2px solid rgba(33,147,119,0.35);border-radius:16px;padding:36px;box-shadow:0 8px 32px rgba(33,147,119,0.08)}
.hdr{text-align:center;border-bottom:1px dashed rgba(33,147,119,0.3);padding-bottom:20px;margin-bottom:24px}
.hdr .logo-row{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:10px}
.hdr h1{color:#219377;font-size:24px;font-weight:900;margin-bottom:6px;letter-spacing:.04em}
.stamp{display:inline-block;background:#219377;color:#fff;padding:5px 22px;border-radius:999px;font-weight:800;font-size:11px;letter-spacing:.12em;margin:4px 0}
.hdr small{color:#525252;font-size:12px}
.row{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid rgba(1,1,1,0.06)}
.row:last-of-type{border-bottom:none}
.lbl{color:#525252;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.1em}
.val{font-weight:600;font-size:13px;color:#010101}
.amt-box{background:#F0FDF9;border:2px solid rgba(33,147,119,0.3);border-radius:14px;padding:20px;text-align:center;margin:22px 0}
.amt-box .lbl{color:#219377;font-size:10px;text-transform:uppercase;letter-spacing:.18em;font-weight:800}
.amt-box .val{color:#219377;font-size:32px;font-weight:900;margin-top:6px}
.bal-box{background:#FFF1F2;border:1.5px solid rgba(239,68,68,0.3);border-radius:14px;padding:14px;text-align:center;margin-bottom:18px}
.verify{background:#F4FBF8;border:1px solid rgba(33,147,119,0.15);border-radius:14px;padding:14px;display:flex;align-items:center;gap:14px;margin-top:18px}
.verify-info{flex:1}
.code{font-family:monospace;font-size:15px;font-weight:700;color:#219377;letter-spacing:2px;margin-top:6px}
.footer{text-align:center;margin-top:22px;color:#525252;font-size:11px}
@media print{.no-print{display:none!important}body{font-size:12px}.wrap{padding:20px}}
</style></head><body>
<div class="wrap"><div class="receipt">
  <div class="hdr">
    <div class="logo-row">${logoHtml}<strong style="font-size:15px;color:#010101">${cfg.company_name||'Property Management'}</strong></div>
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
  ${balAfter>0?`<div class="bal-box"><strong style="color:#dc2626">Outstanding Balance: ${fmt(balAfter)}</strong><br><small style="color:#525252">This amount carries forward to the next period.</small></div>`:''}
  <div class="verify">
    <div class="verify-info">
      <strong style="font-size:11px;color:#219377">Document Verification</strong>
      <div style="font-size:10px;color:#525252;margin-top:3px">Scan QR or visit link to verify authenticity</div>
      <div style="font-size:10px;margin-top:4px"><a href="${verifyUrl}" style="color:#219377;word-break:break-all">${verifyUrl}</a></div>
      <div class="code">${verifyCode}</div>
    </div>
    <div style="text-align:center;flex-shrink:0">
      <img src="${qrDataUrl}" style="width:72px;height:72px;display:block">
      <div style="font-size:10px;color:#525252;margin-top:3px">Scan to verify</div>
    </div>
  </div>
  <div class="footer"><p>${cfg.company_name||'PMS'} &nbsp;|&nbsp; Generated ${new Date().toLocaleDateString('en-GB')}</p></div>
</div></div>
<div class="no-print" style="text-align:center;padding:24px">
  <button onclick="window.print()" style="padding:12px 32px;background:#219377;color:#fff;border:none;border-radius:999px;font-size:15px;cursor:pointer;font-weight:700">🖨️ Print / Save as PDF</button>
</div>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e) { console.error('[receipt pdf]',e.message); res.status(500).send('Error: '+e.message); }
};
