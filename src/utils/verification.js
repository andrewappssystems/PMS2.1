'use strict';
const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../../database/pool');

function makeVerifyCode(docId, type) {
  const secret = process.env.SESSION_SECRET || 'pms-verify-secret';
  return crypto
    .createHmac('sha256', secret)
    .update(`${type}:${docId}`)
    .digest('hex')
    .substring(0, 12)
    .toUpperCase();
}

async function makeVerifyQR(docId, type, req) {
  const code = makeVerifyCode(docId, type);
  const url  = `${req.protocol}://${req.get('host')}/verify/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 90,
    margin: 1,
    color: { dark: '#0f766e', light: '#ffffff' }
  });
  // Persist verification record so /verify/:code can look it up directly
  try {
    const meta = {
      docId: docId,
      type: type,
      host: req.get('host'),
      ip: req.ip || null,
      user: (req.session && req.session.user) ? req.session.user.username || req.session.user : null
    };
    await pool.query(
      `INSERT INTO verifications(code, doc_id, doc_type, meta)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET meta = verifications.meta`,
      [code, String(docId), type, meta]
    );
  } catch (e) {
    // Non-fatal: if persistence fails, verification will still work via code recomputation
    console.error('Failed to persist verification record', e.message || e);
  }
  return { qrDataUrl, verifyCode: code, verifyUrl: url, code, url };
}

function verifyPage(docType, docId, fields, valid = true) {
  const entries = Object.entries(fields).map(([k,v]) =>
    `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #e2e8f0">
      <span style="color:#64748b;font-weight:600">${k}</span>
      <span style="font-weight:600">${v}</span>
    </div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Document Verification</title>
  <style>body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#fff;border-radius:16px;padding:40px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.1)}
  h1{font-size:22px;margin-bottom:6px} p{color:#64748b;font-size:13px;margin-bottom:24px}</style></head>
  <body><div class="box">
  ${valid
    ? `<div style="text-align:center;margin-bottom:24px">
        <div style="font-size:52px">✅</div>
        <h1 style="color:#166534">Document Verified</h1>
        <p>This ${docType} is authentic and was issued by this system.</p>
       </div>
       <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:16px">
         <div style="font-size:11px;text-transform:uppercase;font-weight:700;color:#166534;letter-spacing:.5px;margin-bottom:10px">${docType} Details</div>
         ${entries}
       </div>
       <div style="background:#f8fafc;border-radius:8px;padding:12px;text-align:center;font-size:12px;color:#64748b">
         Verification Code: <strong style="font-family:monospace;font-size:14px;color:#0f766e">${docId}</strong>
       </div>`
    : `<div style="text-align:center">
        <div style="font-size:52px">❌</div>
        <h1 style="color:#991b1b">Verification Failed</h1>
        <p>No document found matching code <strong>${docId}</strong>.<br>This document may be forged or the code is incorrect.</p>
       </div>`}
  </div></body></html>`;
}

module.exports = { makeVerifyCode, makeVerifyQR, verifyPage };
