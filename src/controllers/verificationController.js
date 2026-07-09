'use strict';
const pool = require('../../database/pool');
const { makeVerifyCode, verifyPage } = require('../utils/verification');

exports.verifyDocument = async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    // Check persisted verifications first
    const { rows: vRows } = await pool.query(
      'SELECT code, doc_id, doc_type, meta, created_at FROM verifications WHERE code = $1 LIMIT 1',
      [code]
    );
    if (vRows.length) {
      const v = vRows[0];
      const meta = v.meta || {};
      return res.send(verifyPage('Document', v.doc_id, {
        'Type': v.doc_type || 'Document',
        'Generated': new Date(v.created_at).toLocaleString(),
        'Meta': typeof meta === 'object' ? JSON.stringify(meta) : String(meta)
      }));
    }
    // Search invoices
    const { rows: invRows } = await pool.query(
      `SELECT invoice_id, entity_name, description, amount, month, year, status, created_at
       FROM invoices LIMIT 500`
    );
    for (const i of invRows) {
      if (makeVerifyCode(i.invoice_id, 'INV') === code) {
        return res.send(verifyPage('Invoice', i.invoice_id, {
          'Entity': i.entity_name, 'Description': i.description,
          'Amount': 'UGX ' + Number(i.amount).toLocaleString(),
          'Period': `${i.month||''} ${i.year||''}`,
          'Status': i.status,
          'Issued': new Date(i.created_at).toLocaleDateString('en-GB')
        }));
      }
    }
    // Search receipts
    const { rows: rcpRows } = await pool.query(
      `SELECT receipt_id, tenant_name, unit_number, amount, month, year, payment_method, created_at
       FROM receipts LIMIT 500`
    );
    for (const r of rcpRows) {
      if (makeVerifyCode(r.receipt_id, 'RCP') === code) {
        return res.send(verifyPage('Receipt', r.receipt_id, {
          'Tenant': r.tenant_name, 'Unit': r.unit_number,
          'Amount': 'UGX ' + Number(r.amount).toLocaleString(),
          'Period': `${r.month||''} ${r.year||''}`,
          'Method': r.payment_method,
          'Issued': new Date(r.created_at).toLocaleDateString('en-GB')
        }));
      }
    }
    // Not found
    return res.send(verifyPage('Unknown', code, {}, false));
  } catch (e) {
    res.status(500).send('Verification error: ' + e.message);
  }
};
