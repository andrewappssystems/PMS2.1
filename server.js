'use strict';

const express    = require('express');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const pool       = require('./db');
const path       = require('path');
const crypto     = require('crypto');

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
    res.setHeader('Content-Type','text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${i.invoice_id}</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#333}.hdr{text-align:center;border-bottom:3px solid #0f766e;padding-bottom:20px;margin-bottom:30px}.hdr h1{color:#0f766e;margin:0;font-size:32px}.hdr p{color:#666;margin:4px 0;font-size:13px}.row{display:flex;gap:20px;margin-bottom:30px}.box{background:#f8fafc;padding:20px;border-radius:8px;flex:1}.box h3{margin:0 0 10px;color:#0f766e;font-size:12px;text-transform:uppercase}table{width:100%;border-collapse:collapse;margin:20px 0}th{background:#0f766e;color:#fff;padding:12px;text-align:left}td{padding:12px;border-bottom:1px solid #e2e8f0}.total{text-align:right;font-size:22px;font-weight:700;color:#0f766e;margin-top:20px}.badge{padding:6px 16px;border-radius:20px;font-weight:700;font-size:12px;text-transform:uppercase}.paid{background:#dcfce7;color:#166534}.unpaid{background:#fee2e2;color:#991b1b}.footer{margin-top:50px;text-align:center;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;padding-top:20px}@media print{.no-print{display:none!important}body{margin:0}}</style></head><body>
<div class="hdr"><h1>INVOICE</h1><p><strong>${s.company_name||'Property Management System'}</strong></p><p>${s.company_address||''} | ${s.company_phone||''}</p><p>Invoice #: <strong>${i.invoice_id}</strong></p></div>
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
    res.setHeader('Content-Type','text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${r.receipt_id}</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#333}.receipt{max-width:580px;margin:0 auto;border:2px solid #0f766e;border-radius:12px;padding:40px}.hdr{text-align:center;border-bottom:2px dashed #0f766e;padding-bottom:20px;margin-bottom:30px}.hdr h1{color:#0f766e;margin:0;font-size:28px}.stamp{display:inline-block;background:#0f766e;color:#fff;padding:8px 24px;border-radius:20px;font-weight:700;margin-top:8px}.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e2e8f0}.lbl{color:#64748b;font-weight:600;font-size:13px}.val{font-weight:700;font-size:14px}.amt{background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:20px;text-align:center;margin:28px 0}.amt .lbl{color:#166534;font-size:12px;text-transform:uppercase}.amt .val{color:#0f766e;font-size:34px;font-weight:700;margin-top:6px}.footer{text-align:center;margin-top:28px;color:#94a3b8;font-size:12px}@media print{.no-print{display:none!important}body{margin:0}}</style></head><body>
<div class="receipt"><div class="hdr"><h1>RENT RECEIPT</h1><p>${s.company_name||'Property Management System'}</p><p>${s.company_address||''}</p><div class="stamp">✔ PAID</div><p style="margin-top:10px">Receipt #: <strong>${r.receipt_id}</strong></p></div>
<div class="row"><span class="lbl">Date</span><span class="val">${r.date}</span></div>
<div class="row"><span class="lbl">Received From</span><span class="val">${r.tenant_name||'N/A'}</span></div>
<div class="row"><span class="lbl">Unit</span><span class="val">${r.unit_number||'N/A'}</span></div>
<div class="row"><span class="lbl">Period</span><span class="val">${r.month||''} ${r.year||''}</span></div>
<div class="row"><span class="lbl">Payment Method</span><span class="val">${r.payment_method||'Cash'}</span></div>
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
