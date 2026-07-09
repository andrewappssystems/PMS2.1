'use strict';
const pool = require('../../database/pool');
const { makeVerifyQR } = require('../utils/verification');
const { getTenantBalance } = require('../services/rentService');

exports.getPortfolio = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });
  try {
    const [props, unitStats, rentStats, expStats, arrStats] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM properties WHERE LOWER(status)='active'`),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE LOWER(status)='occupied') AS occupied,
        COUNT(*) FILTER (WHERE LOWER(status)='vacant')   AS vacant,
        COUNT(*)                                          AS total
        FROM units`),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM rent_collection
         WHERE created_at BETWEEN $1::timestamp AND ($2::date + interval '1 day')::timestamp`, [from, to]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM expenses
         WHERE created_at BETWEEN $1::timestamp AND ($2::date + interval '1 day')::timestamp`, [from, to]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT t.tenant_id) AS tenants_in_arrears,
                COALESCE(SUM(rb.carried_balance),0) AS total_arrears
         FROM rent_balances rb
         JOIN tenants t ON t.tenant_id = rb.tenant_id
         WHERE rb.carried_balance > 0 AND LOWER(t.status)='active'`
      )
    ]);
    const us = unitStats.rows[0];
    const rs = rentStats.rows[0];
    const es = expStats.rows[0];
    const ar = arrStats.rows[0];
    res.json({
      period:           { from, to },
      properties:       Number(props.rows[0].count),
      units:            { total: Number(us.total), occupied: Number(us.occupied), vacant: Number(us.vacant) },
      occupancyRate:    us.total > 0 ? Math.round((us.occupied / us.total) * 100) : 0,
      rentCollected:    Number(rs.total),
      rentTransactions: Number(rs.count),
      expenses:         Number(es.total),
      netIncome:        Number(rs.total) - Number(es.total),
      tenantsInArrears: Number(ar.tenants_in_arrears),
      totalArrears:     Number(ar.total_arrears)
    });
  } catch (e) {
    console.error('[/api/reports/portfolio]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getLandlordReport = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });
  try {
    const { rows: llRows } = await pool.query(
      `SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.landlordId]
    );
    if (!llRows.length) return res.status(404).json({ error: 'Landlord not found' });
    const landlord = llRows[0];

    const { rows: propRows } = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id) AS total_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='occupied') AS occupied_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='vacant') AS vacant_units
       FROM properties p WHERE p.landlord_id=$1`,
      [req.params.landlordId]
    );

    const { rows: rentRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(rc.amount),0) AS collected,
              COUNT(rc.rent_id) AS payment_count
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.property_id
       LEFT JOIN rent_collection rc
         ON rc.unit_id = u.unit_id
         AND rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to]
    );

    const { rows: expRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(e.amount),0) AS total_expenses
       FROM properties p
       LEFT JOIN expenses e
         ON e.property_id = p.property_id
         AND e.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to]
    );

    const { rows: arrearsRows } = await pool.query(
      `SELECT t.tenant_id, t.name AS tenant_name,
              u.unit_number, p.name AS property_name,
              t.rent_amount,
              COALESCE(rb.carried_balance,0) AS balance
       FROM tenants t
       JOIN units u ON u.unit_id = t.unit_id
       JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN rent_balances rb ON rb.tenant_id = t.tenant_id
       WHERE p.landlord_id=$1 AND LOWER(t.status)='active' AND COALESCE(rb.carried_balance,0)>0`,
      [req.params.landlordId]
    );

    const { rows: paymentDetails } = await pool.query(
      `SELECT rc.rent_id, t.name AS tenant_name,
              u.unit_number, p.name AS property_name,
              rc.amount, rc.month, rc.year,
              rc.payment_method, rc.payment_type,
              rc.balance_after,
              TO_CHAR(rc.created_at,'YYYY-MM-DD') AS date
       FROM rent_collection rc
       JOIN units u ON u.unit_id = rc.unit_id
       JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN tenants t ON t.tenant_id = rc.tenant_id
       WHERE p.landlord_id=$1
         AND rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       ORDER BY rc.created_at DESC`,
      [req.params.landlordId, from, to]
    );

    const totalCollected = rentRows.reduce((s,r)=>s+parseFloat(r.collected||0),0);
    const totalExpenses  = expRows.reduce((s,r)=>s+parseFloat(r.total_expenses||0),0);
    const managementFee  = totalCollected * (parseFloat(landlord.commission_rate||10)/100);
    const netPayable     = totalCollected - managementFee - totalExpenses;

    const { rows: sRows } = await pool.query('SELECT key,value FROM settings');
    const cfg = {}; sRows.forEach(r => { cfg[r.key]=r.value; });

    res.json({
      landlord, period: { from, to },
      properties: propRows,
      rentByProperty: rentRows,
      expensesByProperty: expRows,
      arrearsDetail: arrearsRows,
      paymentDetails,
      summary: {
        totalCollected, totalExpenses, managementFee,
        managementFeeRate: parseFloat(landlord.commission_rate||10),
        netPayable,
        totalArrears: arrearsRows.reduce((s,r)=>s+parseFloat(r.balance||0),0)
      },
      company: cfg
    });
  } catch (e) {
    console.error('[/api/reports/landlord]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getLandlordReportPdf = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('Date range required');
  try {
    const { rows: llRows } = await pool.query(
      `SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.landlordId]
    );
    if (!llRows.length) return res.status(404).send('Landlord not found');
    const ll = llRows[0];

    const { rows: props } = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id) AS total_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='occupied') AS occupied_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='vacant') AS vacant_units
       FROM properties p WHERE p.landlord_id=$1`,
      [req.params.landlordId]
    );

    const { rows: rentRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(rc.amount),0) AS collected,
              COUNT(rc.rent_id) AS payment_count
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.property_id
       LEFT JOIN rent_collection rc
         ON rc.unit_id = u.unit_id
         AND rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to]
    );

    const { rows: expRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(e.amount),0) AS total_expenses
       FROM properties p
       LEFT JOIN expenses e
         ON e.property_id = p.property_id
         AND e.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to]
    );

    const { rows: arrearsRows } = await pool.query(
      `SELECT t.tenant_id, t.name AS tenant_name,
              u.unit_number, p.name AS property_name,
              t.rent_amount,
              COALESCE(rb.carried_balance,0) AS balance
       FROM tenants t
       JOIN units u ON u.unit_id = t.unit_id
       JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN rent_balances rb ON rb.tenant_id = t.tenant_id
       WHERE p.landlord_id=$1 AND LOWER(t.status)='active' AND COALESCE(rb.carried_balance,0)>0`,
      [req.params.landlordId]
    );

    const { rows: paymentDetails } = await pool.query(
      `SELECT rc.rent_id, t.name AS tenant_name,
              u.unit_number, p.name AS property_name,
              rc.amount, rc.month, rc.year,
              rc.payment_method, rc.payment_type,
              rc.balance_after,
              TO_CHAR(rc.created_at,'YYYY-MM-DD') AS date
       FROM rent_collection rc
       JOIN units u ON u.unit_id = rc.unit_id
       JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN tenants t ON t.tenant_id = rc.tenant_id
       WHERE p.landlord_id=$1
         AND rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
       ORDER BY rc.created_at DESC`,
      [req.params.landlordId, from, to]
    );

    const totalCollected = rentRows.reduce((s,r)=>s+parseFloat(r.collected||0),0);
    const totalExpenses  = expRows.reduce((s,r)=>s+parseFloat(r.total_expenses||0),0);
    const managementFee  = totalCollected * (parseFloat(ll.commission_rate||10)/100);
    const netPayable     = totalCollected - managementFee - totalExpenses;
    const s = {
      totalCollected, totalExpenses, managementFee,
      managementFeeRate: parseFloat(ll.commission_rate||10),
      netPayable,
      totalArrears: arrearsRows.reduce((sum,r)=>sum+parseFloat(r.balance||0),0)
    };

    const { rows: sRows } = await pool.query('SELECT key,value FROM settings WHERE key != \'company_logo\'');
    const company = {}; sRows.forEach(r => { company[r.key]=r.value; });

    const d = { rentByProperty: rentRows, expensesByProperty: expRows };

    const fmt = n => 'UGX ' + Number(n||0).toLocaleString();
    const fromFmt = new Date(from).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    const toFmt   = new Date(to).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    const logoHtml = company.company_logo
      ? `<img src="${company.company_logo}" style="height:56px;object-fit:contain">`
      : `<div style="font-size:32px">🏢</div>`;
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(`LREP-${req.params.landlordId}-${from}-${to}`, 'RPT', req);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Landlord Report — ${ll.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;color:#1e293b;font-size:13px;padding:0}
  .page{max-width:900px;margin:0 auto;padding:32px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #0f766e;margin-bottom:24px}
  .company h1{color:#0f766e;font-size:22px;margin-bottom:4px}
  .company p{color:#64748b;font-size:12px}
  .report-title{text-align:right}
  .report-title h2{font-size:20px;color:#0f172a}
  .report-title p{color:#64748b;font-size:12px;margin-top:4px}
  .summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .sum-card{background:#f8fafc;border-radius:8px;padding:14px;border-left:3px solid #0f766e}
  .sum-card.red{border-color:#ef4444}
  .sum-card.green{border-color:#22c55e}
  .sum-card .lbl{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600;letter-spacing:.4px}
  .sum-card .val{font-size:17px;font-weight:700;margin-top:4px;color:#0f172a}
  .sum-card.green .val{color:#16a34a}
  .sum-card.red .val{color:#dc2626}
  h3{font-size:14px;font-weight:700;margin:20px 0 10px;color:#0f766e;text-transform:uppercase;letter-spacing:.4px}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th{background:#0f766e;color:#fff;padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
  td{padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:12px}
  tr:hover{background:#f8fafc}
  .badge{display:inline-block;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700;text-transform:uppercase}
  .badge.green{background:#dcfce7;color:#166534}
  .badge.red{background:#fee2e2;color:#991b1b}
  .badge.yellow{background:#fef3c7;color:#92400e}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;color:#94a3b8;font-size:11px}
  .landlord-info{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px}
  .landlord-info h2{font-size:16px;color:#0f766e;margin-bottom:8px}
  .landlord-info .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .landlord-info .item .lbl{font-size:11px;color:#64748b;font-weight:600}
  .landlord-info .item .val{font-size:13px;font-weight:600;margin-top:2px}
  .right{text-align:right}
  @media print{.no-print{display:none!important}body{font-size:12px}.page{padding:20px}}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="company" style="display:flex;align-items:center;gap:12px">
      ${logoHtml}
      <div>
        <h1>${company.company_name||'Property Management'}</h1>
        <p>${company.company_address||''}</p>
        <p>${company.company_phone||''} &nbsp;|&nbsp; ${company.company_email||''}</p>
      </div>
    </div>
    <div class="report-title">
      <h2>Landlord Report</h2>
      <p><strong>Period:</strong> ${fromFmt} — ${toFmt}</p>
      <p>Generated: ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</p>
    </div>
  </div>

  <div class="landlord-info">
    <h2>${ll.name}</h2>
    <div class="grid">
      <div class="item"><div class="lbl">Phone</div><div class="val">${ll.phone||'—'}</div></div>
      <div class="item"><div class="lbl">Email</div><div class="val">${ll.email||'—'}</div></div>
      <div class="item"><div class="lbl">Commission Rate</div><div class="val">${ll.commission_rate}%</div></div>
      <div class="item"><div class="lbl">Bank</div><div class="val">${ll.bank_name||'—'}</div></div>
      <div class="item"><div class="lbl">Account No.</div><div class="val">${ll.bank_account||'—'}</div></div>
      <div class="item"><div class="lbl">Properties</div><div class="val">${props.length}</div></div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="sum-card"><div class="lbl">Total Collected</div><div class="val">${fmt(s.totalCollected)}</div></div>
    <div class="sum-card red"><div class="lbl">Management Fee (${s.managementFeeRate}%)</div><div class="val">${fmt(s.managementFee)}</div></div>
    <div class="sum-card red"><div class="lbl">Expenses</div><div class="val">${fmt(s.totalExpenses)}</div></div>
    <div class="sum-card green"><div class="lbl">Net Payable to Landlord</div><div class="val">${fmt(s.netPayable)}</div></div>
  </div>

  <h3>Properties Overview</h3>
  <table>
    <thead><tr><th>Property</th><th>Total Units</th><th>Occupied</th><th>Vacant</th><th class="right">Rent Collected</th><th class="right">Expenses</th><th class="right">Net</th></tr></thead>
    <tbody>
    ${props.map(p=>{
      const rc = d.rentByProperty.find(r=>r.property_id===p.property_id)||{};
      const ec = d.expensesByProperty.find(e=>e.property_id===p.property_id)||{};
      const col = parseFloat(rc.collected||0);
      const exp = parseFloat(ec.total_expenses||0);
      const occ = Number(p.occupied_units), vac = Number(p.vacant_units), tot = Number(p.total_units);
      const occRate = tot > 0 ? Math.round((occ/tot)*100) : 0;
      return `<tr>
        <td><strong>${p.name}</strong><br><small style="color:#64748b">${p.address||''}</small></td>
        <td>${tot}</td>
        <td>${occ} <span class="badge green">${occRate}%</span></td>
        <td>${vac > 0 ? `<span class="badge yellow">${vac}</span>` : '0'}</td>
        <td class="right"><strong>${fmt(col)}</strong></td>
        <td class="right">${fmt(exp)}</td>
        <td class="right"><strong>${fmt(col-exp)}</strong></td>
      </tr>`;
    }).join('')}
    <tr style="background:#f0fdf4;font-weight:700">
      <td>TOTAL</td><td>—</td><td>—</td><td>—</td>
      <td class="right">${fmt(s.totalCollected)}</td>
      <td class="right">${fmt(s.totalExpenses)}</td>
      <td class="right">${fmt(s.totalCollected-s.totalExpenses)}</td>
    </tr>
    </tbody>
  </table>

  ${paymentDetails.length ? `
  <h3>Payment Details (${paymentDetails.length} payments)</h3>
  <table>
    <thead><tr><th>Date</th><th>Tenant</th><th>Unit</th><th>Property</th><th>Month</th><th>Method</th><th>Type</th><th class="right">Amount</th></tr></thead>
    <tbody>
    ${paymentDetails.map(p=>`<tr>
      <td>${p.date}</td><td>${p.tenant_name||'—'}</td><td>${p.unit_number||'—'}</td>
      <td>${p.property_name}</td><td>${p.month} ${p.year}</td>
      <td>${p.payment_method}</td>
      <td><span class="badge ${p.payment_type==='Full'?'green':'yellow'}">${p.payment_type}</span></td>
      <td class="right"><strong>${fmt(p.amount)}</strong></td>
    </tr>`).join('')}
    </tbody>
  </table>` : '<p style="color:#64748b;margin-bottom:16px">No payments recorded in this period.</p>'}

  ${arrearsRows.length ? `
  <h3>Arrears as of Today</h3>
  <table>
    <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th class="right">Monthly Rent</th><th class="right">Outstanding Balance</th></tr></thead>
    <tbody>
    ${arrearsRows.map(a=>`<tr>
      <td>${a.tenant_name}</td><td>${a.unit_number}</td><td>${a.property_name}</td>
      <td class="right">${fmt(a.rent_amount)}</td>
      <td class="right"><strong style="color:#dc2626">${fmt(a.balance)}</strong></td>
    </tr>`).join('')}
    <tr style="font-weight:700">
      <td colspan="4">Total Outstanding</td>
      <td class="right" style="color:#dc2626">${fmt(s.totalArrears)}</td>
    </tr>
    </tbody>
  </table>` : '<p style="color:#16a34a;margin-bottom:16px">✅ No arrears for this landlord\'s properties.</p>'}

  <div style="background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:20px;margin:24px 0">
    <h3 style="margin-top:0;color:#166534">Disbursement Summary</h3>
    <table style="margin:0">
      <tr><td>Total Rent Collected</td><td class="right"><strong>${fmt(s.totalCollected)}</strong></td></tr>
      <tr><td>Less: Management Fee (${s.managementFeeRate}%)</td><td class="right" style="color:#dc2626">- ${fmt(s.managementFee)}</td></tr>
      <tr><td>Less: Expenses</td><td class="right" style="color:#dc2626">- ${fmt(s.totalExpenses)}</td></tr>
      <tr style="font-size:15px;font-weight:700;border-top:2px solid #22c55e">
        <td style="padding-top:10px">NET PAYABLE TO ${(ll.name||'').toUpperCase()}</td>
        <td class="right" style="padding-top:10px;color:#16a34a">${fmt(s.netPayable)}</td>
      </tr>
    </table>
  </div>

  <div class="footer">
    <p>${company.company_name||'Property Management'} &nbsp;|&nbsp; Generated ${new Date().toLocaleDateString('en-GB')} &nbsp;|&nbsp; Confidential</p>
  </div>
</div>
<div class="no-print" style="text-align:center;padding:24px">
  <button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600">🖨️ Print / Save as PDF</button>
</div>
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
</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch (e) {
    console.error('[landlord pdf]', e.message);
    res.status(500).send('Error generating report: ' + e.message);
  }
};

exports.getTenantStatement = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('Date range required');
  try {
    const { rows: tRows } = await pool.query(`
      SELECT t.*, u.unit_number, p.name AS property_name
      FROM tenants t
      LEFT JOIN units u ON u.unit_id = t.unit_id
      LEFT JOIN properties p ON p.property_id = u.property_id
      WHERE t.tenant_id=$1`, [req.params.tenantId]);
    if (!tRows.length) return res.status(404).send('Tenant not found');
    const t = tRows[0];
    const { rows: payments } = await pool.query(`
      SELECT rc.*, TO_CHAR(rc.created_at,'YYYY-MM-DD') AS date
      FROM rent_collection rc
      WHERE rc.tenant_id=$1 AND rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp
      ORDER BY rc.created_at ASC`,
      [req.params.tenantId, from, to]);
    const balance = await getTenantBalance(req.params.tenantId);
    const totalPaid = payments.reduce((s,p)=>s+parseFloat(p.amount||0),0);
    const { rows: sRows } = await pool.query('SELECT key,value FROM settings');
    const cfg = {}; sRows.forEach(r => { cfg[r.key]=r.value; });
    const fmt = n => 'UGX ' + Number(n||0).toLocaleString();
    const logoHtml = cfg.company_logo
      ? `<img src="${cfg.company_logo}" style="height:48px;object-fit:contain">`
      : `<div style="font-size:28px">🏢</div>`;
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(`TST-${req.params.tenantId}-${from}-${to}`, 'RPT', req);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Tenant Statement — ${t.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;color:#1e293b;font-size:13px}
  .page{max-width:800px;margin:0 auto;padding:32px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #0f766e;margin-bottom:24px}
  .company h1{color:#0f766e;font-size:20px;margin-bottom:4px}
  .company p{color:#64748b;font-size:11px}
  .tenant-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .item .lbl{font-size:11px;color:#64748b;font-weight:600}
  .item .val{font-size:13px;font-weight:600;margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th{background:#0f766e;color:#fff;padding:9px 12px;text-align:left;font-size:11px;text-transform:uppercase}
  td{padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:12px}
  .right{text-align:right}
  .badge{display:inline-block;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700;text-transform:uppercase}
  .badge.green{background:#dcfce7;color:#166534}
  .badge.yellow{background:#fef3c7;color:#92400e}
  .balance-box{background:#fff7ed;border:2px solid #f59e0b;border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
  .footer{margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;color:#94a3b8;font-size:11px}
  @media print{.no-print{display:none!important}body{font-size:11px}}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="company" style="display:flex;align-items:center;gap:10px">
      ${logoHtml}
      <div><h1>${cfg.company_name||'Property Management'}</h1>
      <p>${cfg.company_address||''} | ${cfg.company_phone||''}</p></div>
    </div>
    <div style="text-align:right">
      <h2 style="font-size:18px">Tenant Statement</h2>
      <p style="color:#64748b;font-size:12px;margin-top:4px">
        ${new Date(from).toLocaleDateString('en-GB')} — ${new Date(to).toLocaleDateString('en-GB')}
      </p>
    </div>
  </div>
  <div class="tenant-box">
    <div class="item"><div class="lbl">Tenant</div><div class="val">${t.name}</div></div>
    <div class="item"><div class="lbl">Unit</div><div class="val">${t.unit_number||'—'}</div></div>
    <div class="item"><div class="lbl">Property</div><div class="val">${t.property_name||'—'}</div></div>
    <div class="item"><div class="lbl">Phone</div><div class="val">${t.phone||'—'}</div></div>
    <div class="item"><div class="lbl">Monthly Rent</div><div class="val">${fmt(t.rent_amount)}</div></div>
    <div class="item"><div class="lbl">Lease Period</div><div class="val">${t.lease_start||'—'} to ${t.lease_end||'—'}</div></div>
  </div>
  ${balance > 0 ? `
  <div class="balance-box">
    <div><strong style="font-size:14px">⚠️ Outstanding Balance</strong><br><small>Carried forward from previous payments</small></div>
    <strong style="font-size:18px;color:#dc2626">${fmt(balance)}</strong>
  </div>` : ''}
  <table>
    <thead><tr><th>Date</th><th>Period</th><th>Amount Paid</th><th>Method</th><th>Type</th><th class="right">Balance After</th></tr></thead>
    <tbody>
    ${payments.length ? payments.map(p=>`<tr>
      <td>${p.date}</td>
      <td>${p.month} ${p.year}</td>
      <td><strong>${fmt(p.amount)}</strong></td>
      <td>${p.payment_method}</td>
      <td><span class="badge ${p.payment_type==='Full'?'green':'yellow'}">${p.payment_type||'Full'}</span></td>
      <td class="right">${fmt(p.balance_after||0)}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px">No payments in this period</td></tr>'}
    <tr style="font-weight:700;background:#f8fafc">
      <td colspan="2">Total Paid This Period</td>
      <td><strong>${fmt(totalPaid)}</strong></td>
      <td colspan="2"></td>
      <td class="right" style="color:${balance>0?'#dc2626':'#16a34a'}"><strong>${fmt(balance)}</strong></td>
    </tr>
    </tbody>
  </table>
  <div class="footer">
    <p>${cfg.company_name||'PMS'} &nbsp;|&nbsp; Tenant Statement &nbsp;|&nbsp; Generated ${new Date().toLocaleDateString('en-GB')}</p>
  </div>
</div>
<div class="no-print" style="text-align:center;padding:24px">
  <button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600">🖨️ Print / Save as PDF</button>
</div>
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
</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e){ res.status(500).send('Error: '+e.message); }
};

exports.getPortfolioPdf = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('Date range required');
  try {
    const [props, unitStats, rentStats, expStats, arrStats, llStats] = await Promise.all([
      pool.query(`SELECT p.*, l.name AS landlord_name FROM properties p LEFT JOIN landlords l ON l.landlord_id=p.landlord_id WHERE LOWER(p.status)='active'`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE LOWER(status)='occupied') AS occupied, COUNT(*) FILTER (WHERE LOWER(status)='vacant') AS vacant, COUNT(*) AS total FROM units`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM rent_collection WHERE created_at BETWEEN $1::timestamp AND ($2::date + interval '1 day')::timestamp`, [from, to]),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE created_at BETWEEN $1::timestamp AND ($2::date + interval '1 day')::timestamp`, [from, to]),
      pool.query(`SELECT COUNT(DISTINCT t.tenant_id) AS cnt, COALESCE(SUM(rb.carried_balance),0) AS total FROM rent_balances rb JOIN tenants t ON t.tenant_id=rb.tenant_id WHERE rb.carried_balance>0 AND LOWER(t.status)='active'`),
      pool.query(`SELECT COUNT(*) FROM landlords WHERE LOWER(status)='active'`)
    ]);
    const { rows: propBreakdown } = await pool.query(`
      SELECT p.property_id, p.name, l.name AS landlord_name,
        COUNT(u.unit_id) AS total_units,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='occupied') AS occupied,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='vacant') AS vacant,
        COALESCE(SUM(rc.amount) FILTER (WHERE rc.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp),0) AS collected,
        COALESCE(SUM(e.amount) FILTER (WHERE e.created_at BETWEEN $2::timestamp AND ($3::date + interval '1 day')::timestamp),0) AS expenses
      FROM properties p
      LEFT JOIN landlords l ON l.landlord_id=p.landlord_id
      LEFT JOIN units u ON u.property_id=p.property_id
      LEFT JOIN rent_collection rc ON rc.unit_id=u.unit_id
      LEFT JOIN expenses e ON e.property_id=p.property_id
      GROUP BY p.property_id, p.name, l.name ORDER BY collected DESC`,
      ['', from, to]
    );
    const { rows: sRows } = await pool.query('SELECT key,value FROM settings');
    const cfg = {}; sRows.forEach(r => { cfg[r.key]=r.value; });
    const fmt = n => 'UGX ' + Number(n||0).toLocaleString();
    const us = unitStats.rows[0];
    const rs = rentStats.rows[0];
    const es = expStats.rows[0];
    const ar = arrStats.rows[0];
    const occRate = us.total > 0 ? Math.round((us.occupied/us.total)*100) : 0;
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo}" style="height:52px;object-fit:contain">` : `<div style="font-size:30px">🏢</div>`;
    const fromFmt = new Date(from).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
    const toFmt   = new Date(to).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Portfolio Report</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Mona Sans','Inter',system-ui,sans-serif;color:#010101;font-size:13px;background:#FFFFFF}
.page{max-width:960px;margin:0 auto;padding:32px}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:24px;border-bottom:1px solid rgba(33,147,119,0.16);margin-bottom:30px}
.company{display:flex;align-items:center;gap:16px}
.company h1{color:#219377;font-size:24px;margin-bottom:4px;font-weight:900}
.company p{color:#525252;font-size:13px}
.report-meta{text-align:right}
.report-meta h2{font-size:22px;color:#010101}
.report-meta p{color:#525252;font-size:13px;margin-top:6px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px;margin-bottom:30px}
.kpi{background:#F4FBF8;border-radius:20px;padding:18px;border-left:4px solid #219377;box-shadow:0 18px 50px rgba(1,1,1,0.06)}
.kpi.red{border-color:#ef4444} .kpi.green{border-color:#22c55e} .kpi.yellow{border-color:#ffbd59}
.kpi .lbl{font-size:11px;color:#525252;text-transform:uppercase;font-weight:800;letter-spacing:.18em}
.kpi .val{font-size:18px;font-weight:900;margin-top:8px;color:#010101}
.kpi.green .val{color:#16a34a} .kpi.red .val{color:#dc2626} .kpi.yellow .val{color:#B76E00}
h3{font-size:14px;font-weight:900;color:#219377;text-transform:uppercase;letter-spacing:.14em;margin:28px 0 12px}
table{width:100%;border-collapse:collapse;margin-bottom:20px;border-radius:20px;overflow:hidden;box-shadow:0 18px 50px rgba(1,1,1,0.06)}
th{background:#F4FBF8;color:#525252;padding:16px 18px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.16em}
td{padding:16px 18px;border-bottom:1px solid rgba(1,1,1,0.08);font-size:13px;color:#010101}
tr:hover{background:#FAFCFB}
.right{text-align:right}
.badge{display:inline-block;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase}
.badge.green{background:rgba(34,197,94,0.12);color:#166534} .badge.yellow{background:rgba(255,189,89,0.18);color:#B76E00} .badge.red{background:rgba(239,68,68,0.12);color:#991b1b}
.summary-box{background:#FFF4DC;border:2px solid rgba(255,189,89,0.35);border-radius:20px;padding:24px;margin:26px 0}
.footer{margin-top:32px;padding-top:20px;border-top:1px solid rgba(1,1,1,0.08);text-align:center;color:#525252;font-size:12px}
@media print{.no-print{display:none!important}body{font-size:11px}.page{padding:20px}}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="company">${logoHtml}<div><h1>${cfg.company_name||'Property Management'}</h1><p>${cfg.company_address||''} | ${cfg.company_phone||''}</p></div></div>
    <div class="report-meta"><h2>Portfolio Report</h2><p><strong>Period:</strong> ${fromFmt} — ${toFmt}</p><p>Generated: ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</p></div>
  </div>

  <div class="kpi-grid">
    <div class="kpi"><div class="lbl">Active Landlords</div><div class="val">${llStats.rows[0].count}</div></div>
    <div class="kpi"><div class="lbl">Properties</div><div class="val">${props.rows.length}</div></div>
    <div class="kpi"><div class="lbl">Total Units</div><div class="val">${us.total}</div></div>
    <div class="kpi green"><div class="lbl">Occupied (${occRate}%)</div><div class="val">${us.occupied}</div></div>
    <div class="kpi yellow"><div class="lbl">Vacant</div><div class="val">${us.vacant}</div></div>
    <div class="kpi green"><div class="lbl">Rent Collected</div><div class="val" style="font-size:12px">${fmt(rs.total)}</div></div>
    <div class="kpi red"><div class="lbl">Expenses</div><div class="val" style="font-size:12px">${fmt(es.total)}</div></div>
    <div class="kpi green"><div class="lbl">Net Income</div><div class="val" style="font-size:12px">${fmt(Number(rs.total)-Number(es.total))}</div></div>
    <div class="kpi red"><div class="lbl">Total Arrears</div><div class="val" style="font-size:12px">${fmt(ar.total)}</div></div>
    <div class="kpi red"><div class="lbl">Tenants in Arrears</div><div class="val">${ar.cnt}</div></div>
  </div>

  <h3>Property Breakdown</h3>
  <table>
    <thead><tr><th>Property</th><th>Landlord</th><th>Units</th><th>Occupied</th><th>Vacant</th><th class="right">Rent Collected</th><th class="right">Expenses</th><th class="right">Net</th></tr></thead>
    <tbody>
    ${propBreakdown.map(p => {
      const occ = Number(p.occupied), tot = Number(p.total_units);
      const occPct = tot > 0 ? Math.round((occ/tot)*100) : 0;
      const net = Number(p.collected) - Number(p.expenses);
      return `<tr>
        <td><strong>${p.name}</strong></td>
        <td>${p.landlord_name||'—'}</td>
        <td>${tot}</td>
        <td>${occ} <span class="badge ${occPct>=80?'green':occPct>=50?'yellow':'red'}">${occPct}%</span></td>
        <td>${Number(p.vacant)>0?`<span class="badge yellow">${p.vacant}</span>`:'0'}</td>
        <td class="right"><strong>${fmt(p.collected)}</strong></td>
        <td class="right">${fmt(p.expenses)}</td>
        <td class="right" style="color:${net>=0?'#16a34a':'#dc2626'}"><strong>${fmt(net)}</strong></td>
      </tr>`;
    }).join('')}
    <tr style="font-weight:700;background:#f0fdf4">
      <td colspan="5"><strong>TOTAL</strong></td>
      <td class="right">${fmt(rs.total)}</td>
      <td class="right">${fmt(es.total)}</td>
      <td class="right" style="color:${Number(rs.total)-Number(es.total)>=0?'#16a34a':'#dc2626'}">${fmt(Number(rs.total)-Number(es.total))}</td>
    </tr>
    </tbody>
  </table>

  <div class="summary-box">
    <h3 style="margin-top:0;color:#166534">Portfolio Summary</h3>
    <table style="margin:0">
      <tr><td>Total Rent Collected</td><td class="right"><strong>${fmt(rs.total)}</strong></td></tr>
      <tr><td>Total Expenses</td><td class="right" style="color:#dc2626">- ${fmt(es.total)}</td></tr>
      <tr style="font-size:15px;font-weight:700;border-top:2px solid #22c55e">
        <td style="padding-top:10px">NET PORTFOLIO INCOME</td>
        <td class="right" style="padding-top:10px;color:#16a34a">${fmt(Number(rs.total)-Number(es.total))}</td>
      </tr>
    </table>
  </div>

  <div class="footer"><p>${cfg.company_name||'PMS'} | Portfolio Report | Generated ${new Date().toLocaleDateString('en-GB')} | Confidential</p></div>
</div>
<div class="no-print" style="text-align:center;padding:24px">
  <button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;font-weight:600">🖨️ Print / Save as PDF</button>
</div>
</body></html>`;
    res.setHeader('Content-Type','text/html');
    res.send(html);
  } catch(e) { console.error('[portfolio pdf]',e.message); res.status(500).send('Error: '+e.message); }
};
