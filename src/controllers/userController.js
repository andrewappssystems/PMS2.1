'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { hashPassword } = require('../utils/password');

exports.list = async (req, res) => {
  const cached = getCached('users');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT user_id AS "ID", username AS "Username", full_name AS "Name",
             email AS "Email", role AS "Role", status AS "Status",
             TO_CHAR(created_at,'YYYY-MM-DD') AS "Date Added", created_by AS "Added By"
      FROM users ORDER BY id`);
    setCache('users', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['username','Username'],['fullName','Full name'],['role','Role']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { username, fullName, email='', role='User', password='' } = req.body;
    // Check username not taken
    const { rows: existing } = await pool.query(
      'SELECT user_id FROM users WHERE LOWER(username)=LOWER($1)', [username.trim()]
    );
    if (existing.length) return res.status(400).json({ error: 'Username already exists' });
    const id = await getNextId('users', 'user_id', 'USR');
    const hash = password ? hashPassword(password) : '';
    await pool.query(
      `INSERT INTO users (user_id,username,full_name,email,role,password_hash,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'Active',$7)`,
      [id, username.trim(), fullName.trim(), email.trim(), role, hash, actor(req)]
    );
    clearCache('users');
    res.json({ success: true, id });
  } catch (e) {
    console.error('[POST /api/users]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.update = async (req, res) => {
  const err = validate([['fullName','Full name'],['role','Role']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { fullName, email='', role='User', status='Active' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE users SET full_name=$1,email=$2,role=$3,status=$4 WHERE user_id=$5`,
      [fullName.trim(), email.trim(), role, status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    clearCache('users');
    res.json({ success: true });
  } catch (e) {
    console.error('[PUT /api/users]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.updatePassword = async (req, res) => {
  const err = validate([['password','Password']], req.body);
  if (err) return res.status(400).json({ error: err });
  if (req.body.password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = hashPassword(req.body.password);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash=$1 WHERE user_id=$2', [hash, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    clearCache('users');
    res.json({ success: true });
  } catch (e) {
    console.error('[PUT /api/users/password]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.remove = async (req, res) => {
  // Prevent deleting yourself
  if (req.session.user.id === req.params.id)
    return res.status(400).json({ error: 'You cannot delete your own account' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE users SET status='Inactive' WHERE user_id=$1`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    clearCache('users');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
