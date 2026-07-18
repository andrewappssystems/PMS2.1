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
  const key = `invoices_p${page}_l${limit}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT invoice_id AS "ID", type AS "Type", entity_id AS "EntityId",
               entity_name AS "EntityName", description AS "Description",
               amount AS "Amount", month AS "Month", year AS "Year", status AS "Status",
               TO_CHAR(created_at,'YYYY-MM-DD') AS "Date", created_by AS "Added By"
        FROM invoices ORDER BY id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM invoices')
    ]);
    const result = pageResp(data.rows, count.rows[0].count, page, limit);
    setCache(key, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['type','Invoice type'],['entityId','Entity'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { type, entityId, entityName='', description='', amount, month='', year='' } = req.body;
    const id = await getNextId('invoices', 'invoice_id', 'INV');
    await pool.query(
      `INSERT INTO invoices (invoice_id,type,entity_id,entity_name,description,amount,month,year,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Unpaid',$9)`,
      [id, type, entityId, entityName.trim(), description.trim(), parseFloat(amount), month, year?parseInt(year):null, actor(req)]
    );
    clearCachePrefix('invoices_');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/invoices]', e.message); res.status(500).json({ error: e.message }); }
};

exports.markPaid = async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE invoices SET status='Paid' WHERE invoice_id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Invoice not found' });
    clearCachePrefix('invoices_');
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.createV2 = async (req, res) => {
  const err = validate([['type','Invoice type'],['entityId','Entity'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { type, entityId, entityName='', description='', amount, month='', year='' } = req.body;
    const id = await getNextYearId('invoices', 'invoice_id', 'INV');
    await pool.query(
      `INSERT INTO invoices
       (invoice_id,type,entity_id,entity_name,description,amount,month,year,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Unpaid',$9)`,
      [id, type, entityId, entityName.trim(), description.trim(),
       parseFloat(amount), month,
       year ? parseInt(year) : null, actor(req)]
    );
    clearCachePrefix('invoices_');
    res.json({ success: true, id });
  } catch (e) {
    console.error('[POST /api/invoices/v2]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.bulkCreate = async (req, res) => {
  const err = validate([['month','Month'],['year','Year']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { month, year, description='', overrideAmount='' } = req.body;
    const { rows: landlordList } = await pool.query(
      `SELECT l.landlord_id, l.name, l.commission_rate,
              COALESCE(SUM(rc.amount),0) AS total_collected
       FROM landlords l
       LEFT JOIN properties p ON p.landlord_id = l.landlord_id
       LEFT JOIN units u ON u.property_id = p.property_id
       LEFT JOIN rent_collection rc
         ON rc.unit_id = u.unit_id
         AND rc.month = $1 AND rc.year = $2
       WHERE LOWER(l.status)='active'
       GROUP BY l.landlord_id, l.name, l.commission_rate`,
      [month, parseInt(year)]
    );
    const created = [];
    for (const l of landlordList) {
      const collected = parseFloat(l.total_collected) || 0;
      const fee = overrideAmount
        ? parseFloat(overrideAmount)
        : Math.round(collected * (parseFloat(l.commission_rate) / 100));
      if (fee <= 0) continue;
      const id = await getNextYearId('invoices', 'invoice_id', 'INV');
      await pool.query(
        `INSERT INTO invoices
         (invoice_id,type,entity_id,entity_name,description,amount,month,year,status,created_by)
         VALUES ($1,'landlord',$2,$3,$4,$5,$6,$7,'Unpaid',$8)`,
        [id, l.landlord_id, l.name,
         description || `Management fee — ${month} ${year}`,
         fee, month, parseInt(year), actor(req)]
      );
      created.push({ id, landlord: l.name, amount: fee });
    }
    clearCachePrefix('invoices_');
    res.json({ success: true, count: created.length, invoices: created });
  } catch (e) {
    console.error('[POST /api/invoices/bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.createCustom = async (req, res) => {
  const err = validate([['clientName','Client name'],['serviceTitle','Service title'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { clientName, clientEmail='', clientAddress='', serviceTitle, lineItems=[], amount, month='', year='', notes='' } = req.body;
    const id = await getNextYearId('invoices', 'invoice_id', 'INV');
    const desc = lineItems.length
      ? lineItems.map(li=>li.description).join('; ')
      : serviceTitle;
    await pool.query(
      `INSERT INTO invoices (invoice_id,type,entity_id,entity_name,description,amount,month,year,status,created_by)
       VALUES ($1,'custom',$2,$3,$4,$5,$6,$7,'Unpaid',$8)`,
      [id, 'CUSTOM', clientName.trim(), desc, parseFloat(amount), month, year?parseInt(year):null, actor(req)]
    );
    clearCachePrefix('invoices_');
    res.json({ success: true, id });
  } catch(e) { console.error('[custom invoice]',e.message); res.status(500).json({ error: e.message }); }
};

exports.getPdf = async (req, res) => {
  try {
    const [{ rows:invRows }, { rows:sRows }] = await Promise.all([
      pool.query(`SELECT * FROM invoices WHERE invoice_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!invRows.length) return res.status(404).send('Invoice not found');
    const item = invRows[0];
    const cfg = {}; sRows.forEach(r => { cfg[r.key]=r.value; });
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(item.invoice_id, 'INV', req);
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo.startsWith('http') ? '' : '/'}${cfg.company_logo.replace(/^\/+/, '')}" style="height:52px;object-fit:contain">` : '';
    const statusCls = (item.status||'unpaid').toLowerCase();
    const fmt = n => (cfg.currency||'UGX') + ' ' + Number(n||0).toLocaleString();
    const host = `${req.protocol}://${req.get('host')}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${item.invoice_id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;color:#1e293b;font-size:13px}
.page{max-width:800px;margin:0 auto;padding:40px}
.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #0f766e;margin-bottom:28px}
.company h1{color:#0f766e;font-size:22px;margin-bottom:4px}
.company p{color:#64748b;font-size:12px;margin-top:2px}
.inv-meta{text-align:right}
.inv-meta h2{font-size:28px;color:#0f172a;letter-spacing:1px}
.inv-meta .inv-id{font-size:13px;color:#64748b;margin-top:4px}
.inv-meta .status-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;font-size:11px;text-transform:uppercase;margin-top:6px}
.paid{background:#dcfce7;color:#166534} .unpaid{background:#fee2e2;color:#991b1b}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
.party{background:#f8fafc;border-radius:8px;padding:16px}
.party h3{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700;letter-spacing:.5px;margin-bottom:8px}
.party p{font-size:13px;margin-top:3px}
table{width:100%;border-collapse:collapse;margin-bottom:20px}
th{background:#0f766e;color:#fff;padding:10px 14px;text-align:left;font-size:12px}
td{padding:10px 14px;border-bottom:1px solid #e2e8f0}
.right{text-align:right}
.total-row{background:#f0fdf4;font-weight:700;font-size:15px}
.verify{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between;margin-top:24px}
.verify .code{font-family:monospace;font-size:16px;font-weight:700;color:#0f766e;letter-spacing:2px}
.verify small{font-size:11px;color:#94a3b8;display:block;margin-top:2px}
.footer{margin-top:24px;text-align:center;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;padding-top:16px}
@media print{.no-print{display:none!important}body{font-size:12px}.page{padding:24px}}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="company" style="display:flex;align-items:center;gap:12px">
      ${logoHtml}
      <div><h1>${cfg.company_name||'Property Management'}</h1>
      <p>${cfg.company_address||''}</p>
      <p>${cfg.company_phone||''} ${cfg.company_email?'| '+cfg.company_email:''}</p></div>
    </div>
    <div class="inv-meta">
      <h2>INVOICE</h2>
      <div class="inv-id">No. ${item.invoice_id}</div>
      <div class="inv-id">Date: ${new Date(item.created_at).toLocaleDateString('en-GB')}</div>
      <div><span class="status-badge ${statusCls}">${item.status||'Unpaid'}</span></div>
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h3>From</h3>
      <p><strong>${cfg.company_name||'Property Management'}</strong></p>
      <p>${cfg.company_address||''}</p>
      <p>${cfg.company_phone||''}</p>
      <p>${cfg.company_email||''}</p>
    </div>
    <div class="party">
      <h3>Bill To</h3>
      <p><strong>${item.entity_name||'N/A'}</strong></p>
      ${item.type==='custom'&&item.entity_id&&item.entity_id!=='custom'?`<p>${item.entity_id}</p>`:''}
      <p>Period: ${item.month||''} ${item.year||''}</p>
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th class="right">Amount (${cfg.currency||'UGX'})</th></tr></thead>
    <tbody>
      <tr><td>${item.description||'Service Fee'}</td><td class="right">${Number(item.amount||0).toLocaleString()}</td></tr>
      <tr class="total-row"><td><strong>TOTAL</strong></td><td class="right"><strong>${fmt(item.amount)}</strong></td></tr>
    </tbody>
  </table>

 <div class="verify" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;display:flex;align-items:center;justify-content:space-between;margin-top:24px;gap:16px">
  <div>
    <strong style="font-size:12px;color:#374151">Document Verification</strong>
    <div style="font-size:11px;color:#94a3b8;margin-top:3px">Scan the QR code or visit the link to verify this document is authentic</div>
    <div style="margin-top:4px"><a href="${verifyUrl}" style="color:#0f766e;font-size:11px;word-break:break-all">${verifyUrl}</a></div>
    <div style="font-family:monospace;font-size:15px;font-weight:700;color:#0f766e;letter-spacing:2px;margin-top:6px">${verifyCode}</div>
  </div>
  <div style="flex-shrink:0;text-align:center">
    <img src="${qrDataUrl}" style="width:80px;height:80px;display:block">
    <div style="font-size:10px;color:#94a3b8;margin-top:3px">Scan to verify</div>
  </div>
</div>

  <div class="footer"><p>Thank you for your business &nbsp;|&nbsp; ${cfg.company_name||'PMS'} &nbsp;|&nbsp; Generated ${new Date().toLocaleDateString('en-GB')}</p></div>
</div>
<div class="no-print" style="text-align:center;padding:24px">
  <button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600">🖨️ Print / Save as PDF</button>
</div>

</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e) { console.error('[invoice pdf]',e.message); res.status(500).send('Error: '+e.message); }
};
