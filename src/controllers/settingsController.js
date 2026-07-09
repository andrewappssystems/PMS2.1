'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');

exports.list = async (req, res) => {
  const cached = getCached('settings');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key != 'company_logo'`
    );
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    setCache('settings', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.getLogo = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE key='company_logo' LIMIT 1`
    );
    res.json({ logo: rows.length ? rows[0].value : null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool.query(
        `INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [key, value]
      );
    }
    clearCache('settings');
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.uploadLogo = async (req, res) => {
  try {
    const { logoBase64 } = req.body;
    if (!logoBase64) return res.status(400).json({ error: 'No logo data provided' });
    await pool.query(
      `INSERT INTO settings (key,value) VALUES ('company_logo',$1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [logoBase64]
    );
    clearCache('settings');
    res.json({ success: true });
  } catch (e) {
    console.error('[POST /api/settings/logo]', e.message);
    res.status(500).json({ error: e.message });
  }
};
