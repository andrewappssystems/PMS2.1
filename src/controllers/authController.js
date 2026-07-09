const pool = require('../../database/pool');
const { verifyPassword } = require('../utils/password');
const { isProduction } = require('../config/env');

exports.showLogin = (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
};

exports.doLogin = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render('login', { error: 'Username and password are required.' });
  try {
    const { rows } = await pool.query(
      `SELECT user_id,username,full_name,role,password_hash,status,email
       FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`, [username.trim()]
    );
    if (!rows.length) return res.render('login', { error: 'Invalid username or password.' });
    const u = rows[0];
    if ((u.status||'').toLowerCase() !== 'active')
      return res.render('login', { error: 'Account deactivated. Contact your administrator.' });
    const hash = u.password_hash || '';
    if (!hash.trim()) {
      if (isProduction) return res.render('login', { error: 'Account not configured. Contact administrator.' });
      console.warn(`[LOGIN] Dev bypass for "${username}"`);
      req.session.user = { id:u.user_id, name:u.full_name||u.username, username:u.username, role:u.role||'User', email:u.email||'' };
      return res.redirect('/');
    }
    if (!verifyPassword(password, hash))
      return res.render('login', { error: 'Invalid username or password.' });
    req.session.user = { id:u.user_id, name:u.full_name||u.username, username:u.username, role:u.role||'User', email:u.email||'' };
    req.session.save(err => {
      if (err) { console.error('[LOGIN] session save:', err); return res.render('login', { error: 'Session error. Try again.' }); }
      res.redirect('/');
    });
  } catch (e) {
    console.error('[LOGIN]', e.message);
    res.render('login', { error: 'Server error. Please try again.' });
  }
};

exports.doLogout = (req, res) => req.session.destroy(() => res.redirect('/login'));

exports.showDashboard = (req, res) => res.render('dashboard', { user: req.session.user });
