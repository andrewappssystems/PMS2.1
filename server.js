'use strict';

const express    = require('express');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const pool       = require('./db');
const path       = require('path');
const crypto     = require('crypto');
const QRCode     = require('qrcode');
const app          = express();
const isProduction = process.env.NODE_ENV === 'production';

// ── Security Headers ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── App Setup ─────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
if (isProduction) app.set('trust proxy', 1);

// ── Session stored in PostgreSQL ──────────────────────────────────────────────
app.use(session({
  store: new pgSession({
    pool,
    createTableIfMissing: true,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || (() => {
    if (isProduction) { console.error('SESSION_SECRET must be set'); process.exit(1); }
    console.warn('Using insecure dev session secret');
    return 'dev-secret-do-not-use-in-production';
  })(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24*60*60*1000, httpOnly: true, secure: isProduction, sameSite: 'lax' }
}));

// ── Rate Limiting on login ────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.accepts('html')) return res.render('login', { error: 'Too many login attempts. Wait 15 minutes.' });
    res.status(429).json({ error: 'Too many requests' });
  }
});

// ── In-Memory Cache (30s TTL, cleared on writes) ──────────────────────────────
const _cache = new Map();
function getCached(key) {
  const e = _cache.get(key);
  if (e && (Date.now() - e.t) < 30000) return e.d;
  return null;
}
function setCache(key, data) { _cache.set(key, { d: data, t: Date.now() }); }
function clearCache(...keys) {
  if (!keys.length) _cache.clear();
  else keys.forEach(k => _cache.delete(k));
}
function clearCachePrefix(prefix) {
  [..._cache.keys()].filter(k => k.startsWith(prefix)).forEach(k => _cache.delete(k));
}

// ── Password Helpers ──────────────────────────────────────────────────────────
function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomUUID().substring(0, 8);
  const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expected] = storedHash.split(':');
  if (!salt || !expected) return false;
  try {
    const actual = crypto.createHash('sha256').update(password + salt).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch { return false; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'Admin')
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Validation ────────────────────────────────────────────────────────────────
function validate(fields, body) {
  for (const [key, label] of fields)
    if (!body[key] || String(body[key]).trim() === '') return `${label} is required`;
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const actor = req => req.session.user?.name || 'System';
const today = () => new Date().toISOString().split('T')[0];

async function getNextId(table, idColumn, prefix) {
  const { rows } = await pool.query(`SELECT ${idColumn} FROM ${table} ORDER BY id DESC LIMIT 1`);
  if (!rows.length) return `${prefix}-001`;
  const match = String(rows[0][idColumn] || '').match(/(\d+)$/);
  return `${prefix}-${String(match ? parseInt(match[1]) + 1 : 1).padStart(3, '0')}`;
}

function getPagination(query) {
  const page  = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
  return { page, limit, offset: (page - 1) * limit };
}
function pageResp(rows, total, page, limit) {
  return { data: rows, total: Number(total), page, pages: Math.ceil(Number(total) / limit) };
}

// ── Login ─────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', loginLimiter, async (req, res) => {
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
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/', requireAuth, (req, res) => res.render('dashboard', { user: req.session.user }));

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const cached = getCached('stats');
  if (cached) return res.json(cached);
  try {
    const [ll,pr,un,tn,rn,ex,occ,vac] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM landlords'),
      pool.query('SELECT COUNT(*) FROM properties'),
      pool.query('SELECT COUNT(*) FROM units'),
      pool.query('SELECT COUNT(*) FROM tenants'),
      pool.query('SELECT COALESCE(SUM(amount),0) AS t FROM rent_collection'),
      pool.query('SELECT COALESCE(SUM(amount),0) AS t FROM expenses'),
      pool.query("SELECT COUNT(*) FROM units WHERE LOWER(status)='occupied'"),
      pool.query("SELECT COUNT(*) FROM units WHERE LOWER(status)='vacant'")
    ]);
    const result = {
      landlords:Number(ll.rows[0].count), properties:Number(pr.rows[0].count),
      units:Number(un.rows[0].count), tenants:Number(tn.rows[0].count),
      occupied:Number(occ.rows[0].count), vacant:Number(vac.rows[0].count),
      totalRent:Number(rn.rows[0].t), totalExpenses:Number(ex.rows[0].t)
    };
    setCache('stats', result);
    res.json(result);
  } catch (e) { console.error('[/api/stats]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Landlords ─────────────────────────────────────────────────────────────────
app.get('/api/landlords', requireAuth, async (req, res) => {
  const cached = getCached('landlords');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT landlord_id AS "ID", name AS "Name", phone AS "Phone", email AS "Email",
             address AS "Address", bank_name AS "Bank Name", bank_account AS "Bank Account",
             commission_rate AS "Commission Rate", status AS "Status",
             TO_CHAR(created_at,'YYYY-MM-DD') AS "Date Added", created_by AS "Added By"
      FROM landlords ORDER BY id DESC`);
    setCache('landlords', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/landlords', requireAuth, async (req, res) => {
  const err = validate([['name','Name']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone='', email='', address='', bankName='', bankAccount='', commissionRate='10' } = req.body;
    const id = await getNextId('landlords', 'landlord_id', 'LLD');
    await pool.query(
      `INSERT INTO landlords (landlord_id,name,phone,email,address,bank_name,bank_account,commission_rate,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9)`,
      [id, name.trim(), phone.trim(), email.trim(), address.trim(), bankName.trim(), bankAccount.trim(), parseFloat(commissionRate)||10, actor(req)]
    );
    clearCache('landlords','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/landlords]', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/landlords/:id', requireAuth, async (req, res) => {
  const err = validate([['name','Name']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone='', email='', address='', bankName='', bankAccount='', commissionRate='10', status='Active' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE landlords SET name=$1,phone=$2,email=$3,address=$4,bank_name=$5,bank_account=$6,commission_rate=$7,status=$8 WHERE landlord_id=$9`,
      [name.trim(), phone.trim(), email.trim(), address.trim(), bankName.trim(), bankAccount.trim(), parseFloat(commissionRate)||10, status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Landlord not found' });
    clearCache('landlords','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/landlords]', e.message); res.status(500).json({ error: e.message }); }
});

app.delete('/api/landlords/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE landlords SET status='Inactive' WHERE landlord_id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Landlord not found' });
    clearCache('landlords','stats');
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Properties ────────────────────────────────────────────────────────────────
app.get('/api/properties', requireAuth, async (req, res) => {
  const cached = getCached('properties');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT p.property_id AS "ID", p.name AS "Name",
             p.landlord_id AS "Landlord ID", l.name AS "Landlord Name",
             p.address AS "Address", p.type AS "Type",
             (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id)::int AS "Total Units",
             (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='occupied')::int AS "Occupied",
             p.status AS "Status",
             TO_CHAR(p.created_at,'YYYY-MM-DD') AS "Date Added", p.created_by AS "Added By"
      FROM properties p LEFT JOIN landlords l ON l.landlord_id=p.landlord_id ORDER BY p.id DESC`);
    setCache('properties', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/properties', requireAuth, async (req, res) => {
  const err = validate([['name','Property name'],['landlordId','Landlord']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, landlordId, address='', type='Residential' } = req.body;
    const id = await getNextId('properties', 'property_id', 'PRP');
    await pool.query(
      `INSERT INTO properties (property_id,name,landlord_id,address,type,status,created_by) VALUES ($1,$2,$3,$4,$5,'Active',$6)`,
      [id, name.trim(), landlordId, address.trim(), type, actor(req)]
    );
    clearCache('properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/properties]', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/properties/:id', requireAuth, async (req, res) => {
  const err = validate([['name','Property name'],['landlordId','Landlord']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, landlordId, address='', type='Residential', status='Active' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE properties SET name=$1,landlord_id=$2,address=$3,type=$4,status=$5 WHERE property_id=$6`,
      [name.trim(), landlordId, address.trim(), type, status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Property not found' });
    clearCache('properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/properties]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Units ─────────────────────────────────────────────────────────────────────
app.get('/api/units', requireAuth, async (req, res) => {
  const cached = getCached('units');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT u.unit_id AS "ID", u.property_id AS "Property ID",
             p.name AS "Property Name", u.unit_number AS "Unit Number",
             u.type AS "Type", u.rent AS "Rent", u.description AS "Description",
             u.status AS "Status",
             TO_CHAR(u.created_at,'YYYY-MM-DD') AS "Date Added", u.created_by AS "Added By"
      FROM units u LEFT JOIN properties p ON p.property_id=u.property_id ORDER BY u.id DESC`);
    setCache('units', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/units', requireAuth, async (req, res) => {
  const err = validate([['propertyId','Property'],['unitNumber','Unit number']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, unitNumber, type='Studio', rent='0', description='' } = req.body;
    const id = await getNextId('units', 'unit_id', 'UNT');
    await pool.query(
      `INSERT INTO units (unit_id,property_id,unit_number,type,rent,description,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,'Vacant',$7)`,
      [id, propertyId, unitNumber.trim(), type, parseFloat(rent)||0, description.trim(), actor(req)]
    );
    clearCache('units','properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/units]', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/units/:id', requireAuth, async (req, res) => {
  const err = validate([['propertyId','Property'],['unitNumber','Unit number']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, unitNumber, type='Studio', rent='0', description='', status='Vacant' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE units SET property_id=$1,unit_number=$2,type=$3,rent=$4,description=$5,status=$6 WHERE unit_id=$7`,
      [propertyId, unitNumber.trim(), type, parseFloat(rent)||0, description.trim(), status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Unit not found' });
    clearCache('units','properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/units]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Tenants ───────────────────────────────────────────────────────────────────
app.get('/api/tenants', requireAuth, async (req, res) => {
  const cached = getCached('tenants');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT t.tenant_id AS "ID", t.name AS "Name", t.phone AS "Phone",
             t.email AS "Email", t.id_number AS "ID Number",
             t.unit_id AS "Unit ID", u.unit_number AS "Unit Number",
             TO_CHAR(t.lease_start,'YYYY-MM-DD') AS "Lease Start",
             TO_CHAR(t.lease_end,'YYYY-MM-DD')   AS "Lease End",
             t.rent_amount AS "Rent Amount", t.deposit AS "Deposit",
             t.status AS "Status",
             TO_CHAR(t.created_at,'YYYY-MM-DD') AS "Date Added", t.created_by AS "Added By"
      FROM tenants t LEFT JOIN units u ON u.unit_id=t.unit_id ORDER BY t.id DESC`);
    setCache('tenants', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenants', requireAuth, async (req, res) => {
  const err = validate([['name','Name'],['phone','Phone'],['unitId','Unit']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone, email='', idNumber='', unitId, leaseStart='', leaseEnd='', rentAmount='0', deposit='0' } = req.body;
    const id = await getNextId('tenants', 'tenant_id', 'TNT');
    await pool.query(
      `INSERT INTO tenants (tenant_id,name,phone,email,id_number,unit_id,lease_start,lease_end,rent_amount,deposit,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11)`,
      [id, name.trim(), phone.trim(), email.trim(), idNumber.trim(), unitId, leaseStart||null, leaseEnd||null, parseFloat(rentAmount)||0, parseFloat(deposit)||0, actor(req)]
    );
    await pool.query(`UPDATE units SET status='Occupied' WHERE unit_id=$1`, [unitId]);
    clearCache('tenants','units','properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/tenants]', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/tenants/:id', requireAuth, async (req, res) => {
  const err = validate([['name','Name'],['phone','Phone']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone, email='', idNumber='', unitId, leaseStart='', leaseEnd='', rentAmount='0', deposit='0', status='Active' } = req.body;
    const { rows:cur } = await pool.query(`SELECT unit_id FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Tenant not found' });
    const oldUnit = cur[0].unit_id;
    await pool.query(
      `UPDATE tenants SET name=$1,phone=$2,email=$3,id_number=$4,unit_id=$5,lease_start=$6,lease_end=$7,rent_amount=$8,deposit=$9,status=$10 WHERE tenant_id=$11`,
      [name.trim(), phone.trim(), email.trim(), idNumber.trim(), unitId||oldUnit, leaseStart||null, leaseEnd||null, parseFloat(rentAmount)||0, parseFloat(deposit)||0, status, req.params.id]
    );
    if (status.toLowerCase() === 'inactive' && oldUnit)
      await pool.query(`UPDATE units SET status='Vacant' WHERE unit_id=$1`, [oldUnit]);
    if (unitId && unitId !== oldUnit) {
      await pool.query(`UPDATE units SET status='Vacant'   WHERE unit_id=$1`, [oldUnit]);
      await pool.query(`UPDATE units SET status='Occupied' WHERE unit_id=$1`, [unitId]);
    }
    clearCache('tenants','units','properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/tenants]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Rent (paginated) ──────────────────────────────────────────────────────────
app.get('/api/rent', requireAuth, async (req, res) => {
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
});

app.post('/api/rent', requireAuth, async (req, res) => {
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
});

// ── Expenses (paginated) ──────────────────────────────────────────────────────
app.get('/api/expenses', requireAuth, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const key = `expenses_p${page}_l${limit}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT e.expense_id AS "ID", e.property_id AS "Property ID", p.name AS "Property Name",
               e.category AS "Category", e.description AS "Description", e.amount AS "Amount",
               TO_CHAR(e.expense_date,'YYYY-MM-DD') AS "Date",
               TO_CHAR(e.created_at,'YYYY-MM-DD') AS "Date Added", e.created_by AS "Added By"
        FROM expenses e LEFT JOIN properties p ON p.property_id=e.property_id
        ORDER BY e.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM expenses')
    ]);
    const result = pageResp(data.rows, count.rows[0].count, page, limit);
    setCache(key, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  const err = validate([['description','Description'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId='', category='Other', description, amount, date='' } = req.body;
    const id = await getNextId('expenses', 'expense_id', 'EXP');
    await pool.query(
      `INSERT INTO expenses (expense_id,property_id,category,description,amount,expense_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, propertyId||null, category, description.trim(), parseFloat(amount), date||today(), actor(req)]
    );
    clearCachePrefix('expenses_'); clearCache('stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/expenses]', e.message); res.status(500).json({ error: e.message }); }
});

app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  const err = validate([['description','Description'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId='', category='Other', description, amount, date='' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE expenses SET property_id=$1,category=$2,description=$3,amount=$4,expense_date=$5 WHERE expense_id=$6`,
      [propertyId||null, category, description.trim(), parseFloat(amount), date||today(), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
    clearCachePrefix('expenses_'); clearCache('stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/expenses]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Invoices (paginated) ──────────────────────────────────────────────────────
app.get('/api/invoices', requireAuth, async (req, res) => {
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
});

app.post('/api/invoices', requireAuth, async (req, res) => {
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
});

app.put('/api/invoices/:id/pay', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE invoices SET status='Paid' WHERE invoice_id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Invoice not found' });
    clearCachePrefix('invoices_');
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Receipts (paginated) ──────────────────────────────────────────────────────
app.get('/api/receipts', requireAuth, async (req, res) => {
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
});

app.post('/api/receipts', requireAuth, async (req, res) => {
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
});

// ── Users (Admin only) ────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
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
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  const cached = getCached('settings');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    setCache('settings', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, requireAdmin, async (req, res) => {
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
});

// ── Invoice PDF ───────────────────────────────────────────────────────────────
app.get('/api/invoices/:id/pdf', requireAuth, async (req, res) => {
  try {
    const [{ rows:inv }, { rows:cfg }] = await Promise.all([
      pool.query(`SELECT invoice_id,type,entity_id,entity_name,description,amount,month,year,status,TO_CHAR(created_at,'DD/MM/YYYY') AS date FROM invoices WHERE invoice_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!inv.length) return res.status(404).send('Invoice not found');
    const s = {}; cfg.forEach(r => { s[r.key]=r.value; });
    const i = inv[0];
    const logoHtml = s.company_logo
      ? `<img src="${s.company_logo}" style="height:48px;object-fit:contain">`
      : `<div style="font-size:28px">🏢</div>`;
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(i.invoice_id, 'INV', req);
    res.setHeader('Content-Type','text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${i.invoice_id}</title>
<style>body{font-family:'Mona Sans','Inter',system-ui,sans-serif;margin:40px;color:#010101;background:#FFFFFF}.hdr{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid rgba(33,147,119,0.16);padding-bottom:26px;margin-bottom:32px}.hdr h1{color:#219377;margin:0;font-size:34px;font-weight:900}.hdr p{color:#525252;margin:6px 0;font-size:13px}.row{display:flex;gap:20px;margin-bottom:30px}.box{background:#F4FBF8;padding:22px;border-radius:20px;flex:1}.box h3{margin:0 0 10px;color:#219377;font-size:12px;text-transform:uppercase;letter-spacing:.18em}table{width:100%;border-collapse:collapse;margin:20px 0;border-radius:20px;overflow:hidden;box-shadow:0 14px 30px rgba(1,1,1,0.06)}th{background:#F4FBF8;color:#525252;padding:18px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.16em}td{padding:18px;border-bottom:1px solid rgba(1,1,1,0.06);color:#010101}.total{text-align:right;font-size:22px;font-weight:900;color:#219377;margin-top:20px}.badge{padding:8px 18px;border-radius:999px;font-weight:800;font-size:12px;text-transform:uppercase}.paid{background:rgba(34,197,94,0.14);color:#166534}.unpaid{background:rgba(255,189,89,0.18);color:#B76E00}.footer{margin-top:44px;text-align:center;color:#525252;font-size:13px;border-top:1px solid rgba(1,1,1,0.08);padding-top:22px}@media print{.no-print{display:none!important}body{margin:0}}</style></head><body>
  <div class="hdr" style="display:flex;align-items:center;gap:16px"><div>${logoHtml}</div><div><h1>INVOICE</h1><p><strong>${s.company_name||'Property Management System'}</strong></p><p>${s.company_address||''} | ${s.company_phone||''}</p><p>Invoice #: <strong>${i.invoice_id}</strong></p></div></div>
<div class="row"><div class="box"><h3>Bill To</h3><p><strong>${i.entity_name||'N/A'}</strong></p><p>Ref: ${i.entity_id||'—'}</p></div>
<div class="box"><h3>Details</h3><p><strong>Date:</strong> ${i.date}</p><p><strong>Period:</strong> ${i.month||''} ${i.year||''}</p><p><strong>Status:</strong> <span class="badge ${(i.status||'unpaid').toLowerCase()}">${i.status||'Unpaid'}</span></p></div></div>
<table><thead><tr><th>Description</th><th style="text-align:right">Amount (${s.currency||'UGX'})</th></tr></thead>
<tbody><tr><td>${i.description||'Management Fee'}</td><td style="text-align:right">${Number(i.amount||0).toLocaleString()}</td></tr></tbody></table>
<div class="total">Total: ${s.currency||'UGX'} ${Number(i.amount||0).toLocaleString()}</div>
<div class="footer"><p>Thank you for your business</p><p>${s.company_name||'PMS'} | Generated ${new Date().toLocaleDateString('en-GB')}</p></div>
<div class="no-print" style="text-align:center;margin-top:40px"><button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer">🖨️ Print / Save as PDF</button></div>
</body></html>`);
  } catch (e) { console.error('[invoice pdf]', e.message); res.status(500).send('Error: '+e.message); }
});

// ── Receipt PDF ───────────────────────────────────────────────────────────────
app.get('/api/receipts/:id/pdf', requireAuth, async (req, res) => {
  try {
    const [{ rows:rcp }, { rows:cfg }] = await Promise.all([
      pool.query(`SELECT receipt_id,rent_id,tenant_name,unit_number,amount,month,year,payment_method,TO_CHAR(created_at,'DD/MM/YYYY') AS date FROM receipts WHERE receipt_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!rcp.length) return res.status(404).send('Receipt not found');
    const s = {}; cfg.forEach(r => { s[r.key]=r.value; });
    const r = rcp[0];
    const logoHtml = s.company_logo
      ? `<img src="${s.company_logo}" style="height:48px;object-fit:contain">`
      : `<div style="font-size:28px">🏢</div>`;
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(r.receipt_id, 'RCP', req);
    res.setHeader('Content-Type','text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${r.receipt_id}</title>
<style>body{font-family:'Mona Sans','Inter',system-ui,sans-serif;margin:40px;color:#010101;background:#FFFFFF}.receipt{max-width:620px;margin:0 auto;background:#FFFFFF;border-radius:24px;padding:42px;box-shadow:0 30px 80px rgba(1,1,1,0.08);border:1px solid rgba(1,1,1,0.08)}.hdr{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:18px;text-align:left;border-bottom:1px solid rgba(33,147,119,0.16);padding-bottom:26px;margin-bottom:32px}.hdr h1{color:#219377;margin:0;font-size:32px;font-weight:900}.stamp{display:inline-flex;align-items:center;justify-content:center;background:#FFBD59;color:#010101;padding:10px 24px;border-radius:16px;font-weight:800;margin-top:0}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid rgba(1,1,1,0.08)}.lbl{color:#525252;font-weight:700;font-size:13px}.val{font-weight:900;font-size:14px}.amt{background:var(--accent-soft);border:1px solid rgba(255,189,89,0.3);border-radius:20px;padding:22px;text-align:center;margin:28px 0}.amt .lbl{color:#B76E00;font-size:12px;text-transform:uppercase}.amt .val{color:#010101;font-size:34px;font-weight:900;margin-top:6px}.footer{text-align:center;margin-top:32px;color:#525252;font-size:13px}@media print{.no-print{display:none!important}body{margin:0}}</style></head><body>
  <div class="receipt"><div class="hdr" style="display:flex;align-items:center;gap:12px"><div>${logoHtml}</div><div><h1>RENT RECEIPT</h1><p>${s.company_name||'Property Management System'}</p><p>${s.company_address||''}</p></div><div class="stamp">✔ PAID</div><p style="margin-top:10px">Receipt #: <strong>${r.receipt_id}</strong></p></div>
<div class="row"><span class="lbl">Date</span><span class="val">${r.date}</span></div>
<div class="row"><span class="lbl">Received From</span><span class="val">${r.tenant_name||'N/A'}</span></div>
<div class="row"><span class="lbl">Unit</span><span class="val">${r.unit_number||'N/A'}</span></div>
<div class="row"><span class="lbl">Period</span><span class="val">${r.month||''} ${r.year||''}</span></div>
<div class="row"><span class="lbl">Payment Method</span><span class="val">${r.payment_method||'Cash'}</span></div>
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
<div class="amt"><div class="lbl">Amount Received</div><div class="val">${s.currency||'UGX'} ${Number(r.amount||0).toLocaleString()}</div></div>
<div class="footer"><p>Thank you for your payment.</p><p>${s.company_name||'PMS'} | ${new Date().toLocaleDateString('en-GB')}</p></div>
<div class="no-print" style="text-align:center;margin-top:28px"><button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer">🖨️ Print / Save as PDF</button></div>
</div></body></html>`);
  } catch (e) { console.error('[receipt pdf]', e.message); res.status(500).send('Error: '+e.message); }
});
// ── NEW ROUTES TO ADD TO server.js ───────────────────────────────────────────
// ── API: Bulk Units ───────────────────────────────────────────────────────────
app.post('/api/units/bulk', requireAuth, async (req, res) => {
  const err = validate([['propertyId','Property'],['units','Units']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, units: unitList } = req.body;
    if (!Array.isArray(unitList) || !unitList.length)
      return res.status(400).json({ error: 'No units provided' });
    const created = [];
    for (const u of unitList) {
      const id = await getNextId('units', 'unit_id', 'UNT');
      await pool.query(
        `INSERT INTO units (unit_id,property_id,unit_number,type,rent,description,status,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'Vacant',$7)`,
        [id, propertyId, u.unitNumber, u.type||'Studio', parseFloat(u.rent)||0, u.description||'', actor(req)]
      );
      created.push(id);
    }
    clearCache('units','properties','stats');
    res.json({ success: true, count: created.length, ids: created });
  } catch (e) {
    console.error('[POST /api/units/bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: User Management (Admin only) ─────────────────────────────────────────
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
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
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
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
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
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
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
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
});

// ── Settings: Save logo as base64 in settings table ───────────────────────────
app.post('/api/settings/logo', requireAuth, requireAdmin, async (req, res) => {
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
});
'use strict';
// ── ID helpers with year prefix ───────────────────────────────────────────────
async function getNextYearId(table, idColumn, prefix) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT ${idColumn} FROM ${table}
     WHERE ${idColumn} LIKE $1
     ORDER BY id DESC LIMIT 1`,
    [`${prefix}-${year}-%`]
  );
  if (!rows.length) return `${prefix}-${year}-001`;
  const last = rows[0][idColumn] || '';
  const match = last.match(/(\d+)$/);
  const next  = match ? parseInt(match[1]) + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(3,'0')}`;
}

// ── Archive helper ────────────────────────────────────────────────────────────
async function archiveRecord(entityType, entityId, entityLabel, data, deletedBy) {
  await pool.query(
    `INSERT INTO archive (entity_type, entity_id, entity_label, data, deleted_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [entityType, entityId, entityLabel, JSON.stringify(data), deletedBy]
  );
}

// ── Tenant balance helper ─────────────────────────────────────────────────────
async function getTenantBalance(tenantId) {
  const { rows } = await pool.query(
    `SELECT carried_balance FROM rent_balances WHERE tenant_id=$1`, [tenantId]
  );
  return rows.length ? parseFloat(rows[0].carried_balance) : 0;
}
async function setTenantBalance(tenantId, balance) {
  await pool.query(
    `INSERT INTO rent_balances (tenant_id, carried_balance, last_updated)
     VALUES ($1,$2,NOW())
     ON CONFLICT (tenant_id) DO UPDATE
     SET carried_balance=EXCLUDED.carried_balance, last_updated=NOW()`,
    [tenantId, balance]
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// TENANTS — override POST and PUT with new fields
// ═════════════════════════════════════════════════════════════════════════════

// Hard-delete tenant → archive → free unit
app.delete('/api/tenants/:id', requireAuth, async (req, res) => {
  if (!sheetsReady(res)) return;
  try {
    const { rows } = await pool.query(`SELECT * FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = rows[0];
    // Archive
    await archiveRecord('tenant', tenant.tenant_id,
      `${tenant.name} (${tenant.tenant_id})`, tenant, actor(req));
    // Free unit
    if (tenant.unit_id) {
      await pool.query(`UPDATE units SET status='Vacant' WHERE unit_id=$1`, [tenant.unit_id]);
    }
    // Hard delete
    await pool.query(`DELETE FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM rent_balances WHERE tenant_id=$1`, [req.params.id]);
    clearCache('tenants','units','properties','stats');
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /api/tenants]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Hard-delete landlord → archive
app.delete('/api/landlords/:id', requireAuth, async (req, res) => {
  if (!sheetsReady(res)) return;
  try {
    const { rows } = await pool.query(`SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Landlord not found' });
    await archiveRecord('landlord', rows[0].landlord_id,
      rows[0].name, rows[0], actor(req));
    await pool.query(`DELETE FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    clearCache('landlords','stats');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tenant balance endpoint ───────────────────────────────────────────────────
app.get('/api/tenants/:id/balance', requireAuth, async (req, res) => {
  try {
    const balance = await getTenantBalance(req.params.id);
    res.json({ balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// RENT — override POST with partial payment + balance logic
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/rent/v2', requireAuth, async (req, res) => {
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
    // Total owed = expected this month + any previous balance
    const totalOwed = expected + prevBal;
    const newBal    = totalOwed - paid;
    const finalBal  = newBal > 0 ? newBal : 0;
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
    // Update running balance
    await setTenantBalance(tenantId, finalBal);

    clearCachePrefix('rent_'); clearCache('stats');
    res.json({ success: true, id, balanceBefore: prevBal, balanceAfter: finalBal, isPartial });
  } catch (e) {
    console.error('[POST /api/rent/v2]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Rent due status endpoint (for dashboard alert) ────────────────────────────
app.get('/api/rent/due-status', requireAuth, async (req, res) => {
  try {
    const now        = new Date();
    const dayOfMonth = now.getDate();
    const thisMonth  = String(now.getMonth() + 1).padStart(2,'0');
    const thisYear   = now.getFullYear();

    const { rows: activeTenants } = await pool.query(
      `SELECT t.tenant_id, t.name, t.rent_amount,
              u.unit_number, p.name AS property_name,
              rb.carried_balance
       FROM tenants t
       LEFT JOIN units u ON u.unit_id = t.unit_id
       LEFT JOIN properties p ON p.property_id = u.property_id
       LEFT JOIN rent_balances rb ON rb.tenant_id = t.tenant_id
       WHERE LOWER(t.status)='active' AND t.rent_amount > 0`
    );

    const paid = new Set();
    const { rows: payments } = await pool.query(
      `SELECT tenant_id FROM rent_collection
       WHERE month=$1 AND year=$2`, [thisMonth, thisYear]
    );
    payments.forEach(p => paid.add(p.tenant_id));

    const unpaid = activeTenants.filter(t => !paid.has(t.tenant_id));
    const overdue = dayOfMonth > 1 ? unpaid : [];

    res.json({
      dayOfMonth,
      dueToday:   dayOfMonth === 1,
      totalUnpaid: unpaid.length,
      overdueCount: overdue.length,
      unpaidTenants: unpaid.map(t => ({
        id:           t.tenant_id,
        name:         t.name,
        unit:         t.unit_number,
        property:     t.property_name,
        rent:         parseFloat(t.rent_amount),
        carriedBalance: parseFloat(t.carried_balance || 0)
      }))
    });
  } catch (e) {
    console.error('[/api/rent/due-status]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WhatsApp message generator ────────────────────────────────────────────────
app.post('/api/rent/whatsapp-message', requireAuth, async (req, res) => {
  try {
    const { receiptId } = req.body;
    const { rows: sRows } = await pool.query('SELECT key,value FROM settings');
    const cfg = {}; sRows.forEach(r => { cfg[r.key] = r.value; });
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
});

// ═════════════════════════════════════════════════════════════════════════════
// RECEIPTS — year-reset numbering
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/receipts/v2', requireAuth, async (req, res) => {
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
});

// ═════════════════════════════════════════════════════════════════════════════
// INVOICES — year-reset numbering + bulk creation
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/invoices/v2', requireAuth, async (req, res) => {
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
});

// Bulk invoice creation — creates one invoice per landlord (management fees)
app.post('/api/invoices/bulk', requireAuth, async (req, res) => {
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
});

// ═════════════════════════════════════════════════════════════════════════════
// RENT INCREASE
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/rent-increase', requireAuth, async (req, res) => {
  const err = validate([['unitId','Unit'],['newRent','New rent'],['effectiveDate','Effective date']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { unitId, newRent, effectiveDate, notes='' } = req.body;
    // Get current unit rent
    const { rows: unitRows } = await pool.query(
      `SELECT unit_id, rent FROM units WHERE unit_id=$1`, [unitId]
    );
    if (!unitRows.length) return res.status(404).json({ error: 'Unit not found' });
    const oldRent = parseFloat(unitRows[0].rent);
    const nr      = parseFloat(newRent);

    // Get active tenant on this unit
    const { rows: tenantRows } = await pool.query(
      `SELECT tenant_id FROM tenants WHERE unit_id=$1 AND LOWER(status)='active'`, [unitId]
    );
    const tenantId = tenantRows.length ? tenantRows[0].tenant_id : null;

    // Record history
    const hid = await getNextId('rent_increase_history', 'increase_id', 'RNI');
    await pool.query(
      `INSERT INTO rent_increase_history
       (increase_id,unit_id,tenant_id,old_rent,new_rent,effective_date,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [hid, unitId, tenantId, oldRent, nr, effectiveDate, notes.trim(), actor(req)]
    );

    // If effective date is today or past — apply immediately
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
});

app.get('/api/rent-increase/history', requireAuth, async (req, res) => {
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
});

// ═════════════════════════════════════════════════════════════════════════════
// ARCHIVE — search deleted records
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/archive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type='', search='' } = req.query;
    let query = `SELECT id, entity_type, entity_id, entity_label,
                        TO_CHAR(deleted_at,'YYYY-MM-DD HH24:MI') AS deleted_at,
                        deleted_by
                 FROM archive WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); query += ` AND entity_type=$${params.length}`; }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND LOWER(entity_label) LIKE $${params.length}`;
    }
    query += ' ORDER BY id DESC LIMIT 200';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═════════════════════════════════════════════════════════════════════════════

// ── Portfolio summary report ──────────────────────────────────────────────────
app.get('/api/reports/portfolio', requireAuth, async (req, res) => {
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
         WHERE created_at BETWEEN $1 AND $2`, [from, to + ' 23:59:59']
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
         FROM expenses
         WHERE created_at BETWEEN $1 AND $2`, [from, to + ' 23:59:59']
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
});

// ── Landlord report ───────────────────────────────────────────────────────────
app.get('/api/reports/landlord/:landlordId', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });
  try {
    const { rows: llRows } = await pool.query(
      `SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.landlordId]
    );
    if (!llRows.length) return res.status(404).json({ error: 'Landlord not found' });
    const landlord = llRows[0];

    // Properties
    const { rows: propRows } = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id) AS total_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='occupied') AS occupied_units,
        (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='vacant') AS vacant_units
       FROM properties p WHERE p.landlord_id=$1`,
      [req.params.landlordId]
    );

    // Rent collected per property
    const { rows: rentRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(rc.amount),0) AS collected,
              COUNT(rc.rent_id) AS payment_count
       FROM properties p
       LEFT JOIN units u ON u.property_id = p.property_id
       LEFT JOIN rent_collection rc
         ON rc.unit_id = u.unit_id
         AND rc.created_at BETWEEN $2 AND $3
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to + ' 23:59:59']
    );

    // Expenses per property
    const { rows: expRows } = await pool.query(
      `SELECT p.property_id, p.name AS property_name,
              COALESCE(SUM(e.amount),0) AS total_expenses
       FROM properties p
       LEFT JOIN expenses e
         ON e.property_id = p.property_id
         AND e.created_at BETWEEN $2 AND $3
       WHERE p.landlord_id = $1
       GROUP BY p.property_id, p.name`,
      [req.params.landlordId, from, to + ' 23:59:59']
    );

    // Arrears per tenant under this landlord
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

    // Rent payments detail
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
         AND rc.created_at BETWEEN $2 AND $3
       ORDER BY rc.created_at DESC`,
      [req.params.landlordId, from, to + ' 23:59:59']
    );

    // Totals
    const totalCollected = rentRows.reduce((s,r)=>s+parseFloat(r.collected||0),0);
    const totalExpenses  = expRows.reduce((s,r)=>s+parseFloat(r.total_expenses||0),0);
    const managementFee  = totalCollected * (parseFloat(landlord.commission_rate||10)/100);
    const netPayable     = totalCollected - managementFee - totalExpenses;

    // Get settings for company branding
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
});

// ── Landlord report HTML (printable) ─────────────────────────────────────────
app.get('/api/reports/landlord/:landlordId/pdf', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('Date range required');
  try {
    const reportRes = await fetch(
      `http://localhost:${process.env.PORT||3000}/api/reports/landlord/${req.params.landlordId}?from=${from}&to=${to}`,
      { headers: { cookie: req.headers.cookie || '' } }
    );
    const d = await reportRes.json();
    if (d.error) return res.status(404).send(d.error);
    const { landlord: ll, summary: s, properties: props, paymentDetails, arrearsDetail, company } = d;
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

  ${arrearsDetail.length ? `
  <h3>Arrears as of Today</h3>
  <table>
    <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th class="right">Monthly Rent</th><th class="right">Outstanding Balance</th></tr></thead>
    <tbody>
    ${arrearsDetail.map(a=>`<tr>
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
});

// ── Tenant statement ──────────────────────────────────────────────────────────
app.get('/api/reports/tenant/:tenantId/pdf', requireAuth, async (req, res) => {
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
      WHERE rc.tenant_id=$1 AND rc.created_at BETWEEN $2 AND $3
      ORDER BY rc.created_at ASC`,
      [req.params.tenantId, from, to + ' 23:59:59']);
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
});
// ─────────────────────────────────────────────────────────────────────────────
// SERVER FIXES 
// Replaces / extends existing routes

const crypto_hmac = require('crypto'); // already required as crypto

// ── Verification helper ───────────────────────────────────────────────────────
function makeVerifyCode(docId, type) {
  const secret = process.env.SESSION_SECRET || 'pms-verify-secret';
  return crypto_hmac
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
// ── Public verification endpoint (no auth required) ───────────────────────────
app.get('/verify/:code', async (req, res) => {
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
});

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

// ── Portfolio report — HTML printable version ─────────────────────────────────
app.get('/api/reports/portfolio/pdf', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('Date range required');
  try {
    const [props, unitStats, rentStats, expStats, arrStats, llStats] = await Promise.all([
      pool.query(`SELECT p.*, l.name AS landlord_name FROM properties p LEFT JOIN landlords l ON l.landlord_id=p.landlord_id WHERE LOWER(p.status)='active'`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE LOWER(status)='occupied') AS occupied, COUNT(*) FILTER (WHERE LOWER(status)='vacant') AS vacant, COUNT(*) AS total FROM units`),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM rent_collection WHERE created_at BETWEEN $1 AND $2`, [from, to+' 23:59:59']),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE created_at BETWEEN $1 AND $2`, [from, to+' 23:59:59']),
      pool.query(`SELECT COUNT(DISTINCT t.tenant_id) AS cnt, COALESCE(SUM(rb.carried_balance),0) AS total FROM rent_balances rb JOIN tenants t ON t.tenant_id=rb.tenant_id WHERE rb.carried_balance>0 AND LOWER(t.status)='active'`),
      pool.query(`SELECT COUNT(*) FROM landlords WHERE LOWER(status)='active'`)
    ]);
    // Per-property breakdown
    const { rows: propBreakdown } = await pool.query(`
      SELECT p.property_id, p.name, l.name AS landlord_name,
        COUNT(u.unit_id) AS total_units,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='occupied') AS occupied,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='vacant') AS vacant,
        COALESCE(SUM(rc.amount) FILTER (WHERE rc.created_at BETWEEN $2 AND $3),0) AS collected,
        COALESCE(SUM(e.amount) FILTER (WHERE e.created_at BETWEEN $2 AND $3),0) AS expenses
      FROM properties p
      LEFT JOIN landlords l ON l.landlord_id=p.landlord_id
      LEFT JOIN units u ON u.property_id=p.property_id
      LEFT JOIN rent_collection rc ON rc.unit_id=u.unit_id
      LEFT JOIN expenses e ON e.property_id=p.property_id
      GROUP BY p.property_id, p.name, l.name ORDER BY collected DESC`,
      ['', from, to+' 23:59:59']
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
});

// ── Landlord portfolio view ───────────────────────────────────────────────────
app.get('/api/landlords/:id/portfolio', requireAuth, async (req, res) => {
  try {
    const { rows: llRows } = await pool.query(`SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    if (!llRows.length) return res.status(404).json({ error: 'Landlord not found' });
    const l = llRows[0];
    const { rows: propRows } = await pool.query(`
      SELECT p.*,
        COUNT(u.unit_id)::int AS total_units,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='occupied')::int AS occupied,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='vacant')::int AS vacant,
        COALESCE(SUM(u.rent) FILTER (WHERE LOWER(u.status)='occupied'),0) AS monthly_rent_roll
      FROM properties p
      LEFT JOIN units u ON u.property_id=p.property_id
      WHERE p.landlord_id=$1
      GROUP BY p.property_id ORDER BY p.name`, [req.params.id]
    );
    const { rows: arrearsRows } = await pool.query(`
      SELECT COALESCE(SUM(rb.carried_balance),0) AS total
      FROM rent_balances rb
      JOIN tenants t ON t.tenant_id=rb.tenant_id
      JOIN units u ON u.unit_id=t.unit_id
      JOIN properties p ON p.property_id=u.property_id
      WHERE p.landlord_id=$1 AND rb.carried_balance>0`, [req.params.id]
    );
    const totalUnits    = propRows.reduce((s,p)=>s+p.total_units,0);
    const totalOccupied = propRows.reduce((s,p)=>s+p.occupied,0);
    const totalVacant   = propRows.reduce((s,p)=>s+p.vacant,0);
    const monthlyRoll   = propRows.reduce((s,p)=>s+parseFloat(p.monthly_rent_roll||0),0);
    res.json({
      landlord: l, properties: propRows,
      summary: { totalProperties: propRows.length, totalUnits, totalOccupied, totalVacant, monthlyRoll, totalArrears: parseFloat(arrearsRows[0].total||0) }
    });
  } catch(e) { console.error('[landlord portfolio]',e.message); res.status(500).json({ error: e.message }); }
});

// ── General / custom invoice ──────────────────────────────────────────────────
app.post('/api/invoices/custom', requireAuth, async (req, res) => {
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
      [id, clientEmail||'custom', clientName.trim(), desc, parseFloat(amount), month, year?parseInt(year):null, actor(req)]
    );
    clearCachePrefix('invoices_');
    res.json({ success: true, id });
  } catch(e) { console.error('[custom invoice]',e.message); res.status(500).json({ error: e.message }); }
});

// ── Custom invoice PDF (richer layout with line items) ────────────────────────
app.get('/api/invoices/:id/pdf', requireAuth, async (req, res) => {
  try {
    const [{ rows:invRows }, { rows:sRows }] = await Promise.all([
      pool.query(`SELECT * FROM invoices WHERE invoice_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!invRows.length) return res.status(404).send('Invoice not found');
    const item = invRows[0];
    const cfg = {}; sRows.forEach(r => { cfg[r.key]=r.value; });
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(item.invoice_id, 'INV', req);
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo}" style="height:52px;object-fit:contain">` : '';
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
});

// ── Receipt PDF — with logo and verification ──────────────────────────────────
app.get('/api/receipts/:id/pdf', requireAuth, async (req, res) => {
  try {
    const [{ rows:rcpRows }, { rows:sRows }] = await Promise.all([
      pool.query(`SELECT * FROM receipts WHERE receipt_id=$1`, [req.params.id]),
      pool.query('SELECT key,value FROM settings')
    ]);
    if (!rcpRows.length) return res.status(404).send('Receipt not found');
    const r = rcpRows[0];
    const cfg = {}; sRows.forEach(s => { cfg[s.key]=s.value; });
    const { qrDataUrl, verifyCode, verifyUrl } = await makeVerifyQR(r.receipt_id, 'RCP', req);
    const logoHtml = cfg.company_logo ? `<img src="${cfg.company_logo}" style="height:44px;object-fit:contain">` : '';
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
});
// ── 404 & Error Handler ───────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  res.redirect('/');
});
app.use((err, req, res, next) => {
  console.error('[UNHANDLED]', err.message, err.stack);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).render('login', { error: 'An unexpected error occurred.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PMS running on port ${PORT} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
});
