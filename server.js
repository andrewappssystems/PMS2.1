const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Google Sheets Setup ──────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
let auth, sheets;

function initSheets() {
  try {
    const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets API initialized');
  } catch (e) {
    console.error('❌ Failed to init Google Sheets:', e.message);
  }
}
initSheets();

// ── Sheet Names ─────────────────────────────────────────────────────
const SHEET_NAMES = {
  USERS: 'Users',
  LANDLORDS: 'Landlords',
  PROPERTIES: 'Properties',
  UNITS: 'Units',
  TENANTS: 'Tenants',
  RENT: 'Rent Collection',
  EXPENSES: 'Expenses',
  SETTINGS: 'Settings',
  INVOICES: 'Invoices',
  RECEIPTS: 'Receipts'
};

// ── Password Hashing (matches Apps Script exactly) ────────────────────
function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomUUID().substring(0, 8);
  const salted = password + salt;
  const hash = crypto.createHash('sha256').update(salted).digest();
  const hashHex = Array.from(hash).map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return `${salt}:${hashHex}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    console.log('Invalid hash format:', storedHash);
    return false;
  }
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    console.log('Hash does not have exactly 2 parts');
    return false;
  }
  const salt = parts[0];
  const expected = hashPassword(password, salt);
  const match = expected === storedHash;
  console.log('Hash comparison:', match ? 'MATCH' : 'NO MATCH');
  return match;
}

// ── Auth Middleware ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ── Sheet Helpers ────────────────────────────────────────────────────
async function getSheetData(sheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:Z1000`
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return [];
    const headers = rows[0];
    return rows.slice(1).map((row, i) => {
      const obj = {};
      headers.forEach((h, j) => obj[h] = row[j] || '');
      obj._rowIndex = i + 2;
      return obj;
    });
  } catch (e) {
    console.error(`ERROR reading sheet ${sheetName}:`, e.message);
    return [];
  }
}

async function appendRow(sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  });
}

async function updateRow(sheetName, rowIndex, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  });
}

async function getNextId(sheetName, prefix) {
  const data = await getSheetData(sheetName);
  if (data.length === 0) return prefix + '-001';
  const nums = data.map(r => {
    const m = (r.ID || r.UserID || '').match(/\d+/);
    return m ? parseInt(m[0]) : 0;
  });
  const max = Math.max(...nums, 0);
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

// ── Helper: Get password field with fallback ─────────────────────────
function getPassword(user) {
  // Try different possible column names
  return user['Password Hash'] || user.Password || user.password || user['Password'] || '';
}

function getUsername(user) {
  return user.Username || user.username || user['User Name'] || user.sernam || '';
}

function getUserId(user) {
  return user.ID || user.UserID || user['User ID'] || user.id || '';
}

function getUserName(user) {
  return user.Name || user['Full Name'] || user['FullName'] || user.FullName || user.username || '';
}

function getUserRole(user) {
  return user.Role || user.role || user['User Role'] || 'User';
}

function getUserEmail(user) {
  return user.Email || user.email || user['Email Address'] || '';
}

// ── Routes ────────────────────────────────────────────────────────────

// Login Page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('Login attempt for:', username);

  try {
    if (!sheets) {
      console.error('Google Sheets not initialized');
      return res.render('login', { error: 'Server configuration error.' });
    }

    const users = await getSheetData(SHEET_NAMES.USERS);
    console.log('Users sheet rows:', users.length);

    if (users.length === 0) {
      return res.render('login', { error: 'No users configured.' });
    }

    // DEBUG: Log first user structure
    const firstUser = users[0];
    console.log('First user keys:', Object.keys(firstUser));
    console.log('First user username field:', getUsername(firstUser));
    console.log('First user password field:', getPassword(firstUser) ? 'PRESENT' : 'EMPTY');

    const user = users.find(u => getUsername(u) === username);
    console.log('Found user:', user ? 'YES - ' + getUsername(user) : 'NO');

    if (!user) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    const storedHash = getPassword(user);
    console.log('Password hash present:', storedHash ? 'YES (' + storedHash.substring(0, 20) + '...)' : 'NO');

    // If password is empty, allow bypass (temporary)
    if (!storedHash || storedHash.trim() === '') {
      console.log('⚠️  User has no password hash. Using temporary bypass.');
      req.session.user = {
        id: getUserId(user),
        name: getUserName(user),
        username: getUsername(user),
        role: getUserRole(user),
        email: getUserEmail(user)
      };
      console.log('Session created (empty password bypass):', req.session.user);
      return res.redirect('/');
    }

    const valid = verifyPassword(password, storedHash);
    console.log('Password valid:', valid);

    if (!valid) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    req.session.user = {
      id: getUserId(user),
      name: getUserName(user),
      username: getUsername(user),
      role: getUserRole(user),
      email: getUserEmail(user)
    };

    console.log('Session created:', req.session.user);
    res.redirect('/');
  } catch (e) {
    console.error('Login error:', e.message, e.stack);
    res.render('login', { error: 'Server error: ' + e.message });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get('/', requireAuth, async (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

// ── API: Stats ────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [landlords, properties, units, tenants, rent, expenses] = await Promise.all([
      getSheetData(SHEET_NAMES.LANDLORDS),
      getSheetData(SHEET_NAMES.PROPERTIES),
      getSheetData(SHEET_NAMES.UNITS),
      getSheetData(SHEET_NAMES.TENANTS),
      getSheetData(SHEET_NAMES.RENT),
      getSheetData(SHEET_NAMES.EXPENSES)
    ]);

    const totalRent = rent.reduce((s, r) => s + (parseFloat(r.Amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.Amount) || 0), 0);
    const occupied = units.filter(u => u.Status === 'Occupied').length;
    const vacant = units.filter(u => u.Status === 'Vacant').length;

    res.json({
      landlords: landlords.length,
      properties: properties.length,
      units: units.length,
      tenants: tenants.length,
      occupied,
      vacant,
      totalRent,
      totalExpenses
    });
  } catch (e) {
    console.error('Stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Landlords ────────────────────────────────────────────────────
app.get('/api/landlords', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.LANDLORDS); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/landlords', requireAuth, async (req, res) => {
  try {
    const { name, phone, email, address, bankName, bankAccount, commissionRate } = req.body;
    const id = await getNextId(SHEET_NAMES.LANDLORDS, 'LLD');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.LANDLORDS, [id, name, phone || '', email || '', address || '', bankName || '', bankAccount || '', commissionRate || '10', 'Active', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/landlords/:id', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.LANDLORDS);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { name, phone, email, address, bankName, bankAccount, commissionRate, status } = req.body;
    await updateRow(SHEET_NAMES.LANDLORDS, row._rowIndex, [req.params.id, name, phone || '', email || '', address || '', bankName || '', bankAccount || '', commissionRate || '10', status || 'Active', row['Date Added'] || '', row['Added By'] || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/landlords/:id', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.LANDLORDS);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const vals = Object.values(row).filter((_, i) => i < Object.keys(row).length - 1);
    vals[8] = 'Inactive';
    await updateRow(SHEET_NAMES.LANDLORDS, row._rowIndex, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Properties ────────────────────────────────────────────────────
app.get('/api/properties', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.PROPERTIES); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/properties', requireAuth, async (req, res) => {
  try {
    const { name, landlordId, address, type } = req.body;
    const id = await getNextId(SHEET_NAMES.PROPERTIES, 'PRP');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.PROPERTIES, [id, name, landlordId, address || '', type || 'Residential', '0', '0', 'Active', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/properties/:id', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.PROPERTIES);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { name, landlordId, address, type, status } = req.body;
    await updateRow(SHEET_NAMES.PROPERTIES, row._rowIndex, [req.params.id, name, landlordId, address || '', type || 'Residential', row['Total Units'] || '0', row['Occupied'] || '0', status || 'Active', row['Date Added'] || '', row['Added By'] || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Units ────────────────────────────────────────────────────────
app.get('/api/units', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.UNITS); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/units', requireAuth, async (req, res) => {
  try {
    const { propertyId, unitNumber, type, rent, description } = req.body;
    const id = await getNextId(SHEET_NAMES.UNITS, 'UNT');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.UNITS, [id, propertyId, unitNumber, type || 'Studio', rent || '0', description || '', 'Vacant', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/units/:id', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.UNITS);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { propertyId, unitNumber, type, rent, description, status } = req.body;
    await updateRow(SHEET_NAMES.UNITS, row._rowIndex, [req.params.id, propertyId, unitNumber, type || 'Studio', rent || '0', description || '', status || 'Vacant', row['Date Added'] || '', row['Added By'] || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Tenants ──────────────────────────────────────────────────────
app.get('/api/tenants', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.TENANTS); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenants', requireAuth, async (req, res) => {
  try {
    const { name, phone, email, idNumber, unitId, leaseStart, leaseEnd, rentAmount, deposit } = req.body;
    const id = await getNextId(SHEET_NAMES.TENANTS, 'TNT');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.TENANTS, [id, name, phone || '', email || '', idNumber || '', unitId, leaseStart || '', leaseEnd || '', rentAmount || '0', deposit || '0', 'Active', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tenants/:id', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.TENANTS);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const { name, phone, email, idNumber, unitId, leaseStart, leaseEnd, rentAmount, deposit, status } = req.body;
    await updateRow(SHEET_NAMES.TENANTS, row._rowIndex, [req.params.id, name, phone || '', email || '', idNumber || '', unitId, leaseStart || '', leaseEnd || '', rentAmount || '0', deposit || '0', status || 'Active', row['Date Added'] || '', row['Added By'] || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Rent Collection ───────────────────────────────────────────────
app.get('/api/rent', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.RENT); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rent', requireAuth, async (req, res) => {
  try {
    const { tenantId, unitId, amount, month, year, paymentMethod, reference } = req.body;
    const id = await getNextId(SHEET_NAMES.RENT, 'RNT');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.RENT, [id, tenantId, unitId, amount || '0', month || '', year || '', paymentMethod || 'Cash', reference || '', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Expenses ─────────────────────────────────────────────────────
app.get('/api/expenses', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.EXPENSES); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { propertyId, category, description, amount, date } = req.body;
    const id = await getNextId(SHEET_NAMES.EXPENSES, 'EXP');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.EXPENSES, [id, propertyId || '', category || 'Other', description || '', amount || '0', date || now, now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Invoices ─────────────────────────────────────────────────────
app.get('/api/invoices', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.INVOICES); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices', requireAuth, async (req, res) => {
  try {
    const { type, entityId, entityName, description, amount, month, year } = req.body;
    const id = await getNextId(SHEET_NAMES.INVOICES, 'INV');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.INVOICES, [id, type || 'landlord', entityId || '', entityName || '', description || '', amount || '0', month || '', year || '', 'Unpaid', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/invoices/:id/pay', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.INVOICES);
    const row = data.find(r => r.ID === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const vals = Object.values(row).filter((_, i) => i < Object.keys(row).length - 1);
    vals[8] = 'Paid';
    await updateRow(SHEET_NAMES.INVOICES, row._rowIndex, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Receipts ────────────────────────────────────────────────────
app.get('/api/receipts', requireAuth, async (req, res) => {
  try { const data = await getSheetData(SHEET_NAMES.RECEIPTS); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/receipts', requireAuth, async (req, res) => {
  try {
    const { rentId, tenantName, unitNumber, amount, month, year, paymentMethod } = req.body;
    const id = await getNextId(SHEET_NAMES.RECEIPTS, 'RCP');
    const now = new Date().toISOString();
    await appendRow(SHEET_NAMES.RECEIPTS, [id, rentId || '', tenantName || '', unitNumber || '', amount || '0', month || '', year || '', paymentMethod || 'Cash', now, req.session.user.name]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Settings ─────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const data = await getSheetData(SHEET_NAMES.SETTINGS);
    const settings = {};
    data.forEach(s => { if (s.Key) settings[s.Key] = s.Value; });
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PDF Generation ────────────────────────────────────────────────────
app.get('/api/invoices/:id/pdf', requireAuth, async (req, res) => {
  try {
    const invoices = await getSheetData(SHEET_NAMES.INVOICES);
    const inv = invoices.find(i => i.ID === req.params.id);
    if (!inv) return res.status(404).send('Invoice not found');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Invoice ${inv.ID}</title>
<style>
body{font-family:Arial,sans-serif;margin:40px;color:#333}
.header{text-align:center;border-bottom:3px solid #0f766e;padding-bottom:20px;margin-bottom:30px}
.header h1{color:#0f766e;margin:0;font-size:32px}
.header p{color:#666;margin:5px 0}
.invoice-details{display:flex;justify-content:space-between;margin-bottom:30px}
.box{background:#f8fafc;padding:20px;border-radius:8px}
.box h3{margin:0 0 10px 0;color:#0f766e;font-size:14px;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin:20px 0}
th{background:#0f766e;color:white;padding:12px;text-align:left}
td{padding:12px;border-bottom:1px solid #e2e8f0}
.total{text-align:right;font-size:24px;font-weight:bold;color:#0f766e;margin-top:30px}
.status{display:inline-block;padding:6px 16px;border-radius:20px;font-weight:bold;font-size:12px;text-transform:uppercase}
.status.paid{background:#dcfce7;color:#166534}
.status.unpaid{background:#fee2e2;color:#991b1b}
.footer{margin-top:50px;text-align:center;color:#94a3b8;font-size:12px}
@media print{body{margin:0}.no-print{display:none}}
</style></head><body>
<div class="header"><h1>INVOICE</h1><p>Property Management System</p><p>Invoice #: ${inv.ID}</p></div>
<div class="invoice-details">
<div class="box"><h3>Bill To</h3><p><strong>${inv.EntityName || 'N/A'}</strong></p><p>ID: ${inv.EntityId || 'N/A'}</p></div>
<div class="box"><h3>Invoice Details</h3><p><strong>Date:</strong> ${inv.Date || new Date().toLocaleDateString()}</p><p><strong>Period:</strong> ${inv.Month || ''} ${inv.Year || ''}</p><p><strong>Status:</strong> <span class="status ${(inv.Status || '').toLowerCase()}">${inv.Status || 'Unpaid'}</span></p></div>
</div>
<table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
<tbody><tr><td>${inv.Description || 'Management Fee'}</td><td style="text-align:right">${inv.Amount || '0'}</td></tr></tbody></table>
<div class="total">Total: ${inv.Amount || '0'}</div>
<div class="footer"><p>Thank you for your business</p><p>Generated by Property Management System</p></div>
<div class="no-print" style="text-align:center;margin-top:40px"><button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer">Print / Save as PDF</button></div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/api/receipts/:id/pdf', requireAuth, async (req, res) => {
  try {
    const receipts = await getSheetData(SHEET_NAMES.RECEIPTS);
    const rcp = receipts.find(r => r.ID === req.params.id);
    if (!rcp) return res.status(404).send('Receipt not found');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Receipt ${rcp.ID}</title>
<style>
body{font-family:Arial,sans-serif;margin:40px;color:#333}
.receipt{max-width:600px;margin:0 auto;border:2px solid #0f766e;border-radius:12px;padding:40px}
.header{text-align:center;border-bottom:2px dashed #0f766e;padding-bottom:20px;margin-bottom:30px}
.header h1{color:#0f766e;margin:0;font-size:28px}
.stamp{display:inline-block;background:#0f766e;color:white;padding:8px 24px;border-radius:20px;font-weight:bold;margin-top:10px}
.detail-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e2e8f0}
.detail-row .label{color:#64748b;font-weight:600}
.detail-row .value{font-weight:bold;color:#0f172a}
.amount-box{background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:20px;text-align:center;margin:30px 0}
.amount-box .label{color:#166534;font-size:14px;text-transform:uppercase}
.amount-box .value{color:#0f766e;font-size:36px;font-weight:bold}
.footer{text-align:center;margin-top:30px;color:#94a3b8;font-size:12px}
@media print{body{margin:0}.no-print{display:none}}
</style></head><body>
<div class="receipt">
<div class="header"><h1>RENT RECEIPT</h1><div class="stamp">PAID</div><p style="margin-top:10px;color:#666">Receipt #: ${rcp.ID}</p></div>
<div class="detail-row"><span class="label">Date</span><span class="value">${rcp.Date || new Date().toLocaleDateString()}</span></div>
<div class="detail-row"><span class="label">Received From</span><span class="value">${rcp.TenantName || 'N/A'}</span></div>
<div class="detail-row"><span class="label">Unit</span><span class="value">${rcp.UnitNumber || 'N/A'}</span></div>
<div class="detail-row"><span class="label">Period</span><span class="value">${rcp.Month || ''} ${rcp.Year || ''}</span></div>
<div class="detail-row"><span class="label">Payment Method</span><span class="value">${rcp.PaymentMethod || 'Cash'}</span></div>
<div class="amount-box"><div class="label">Amount Received</div><div class="value">${rcp.Amount || '0'}</div></div>
<div class="footer"><p>Thank you for your payment</p><p>Property Management System</p></div>
<div class="no-print" style="text-align:center;margin-top:30px"><button onclick="window.print()" style="padding:12px 32px;background:#0f766e;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer">Print / Save as PDF</button></div>
</div></body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ── Error Handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).render('login', { error: 'Server error: ' + err.message });
});

// ── Start Server ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PMS Server running on port ${PORT}`);
  console.log(`📊 Spreadsheet: ${SPREADSHEET_ID}`);
});
