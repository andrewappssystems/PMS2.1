const express = require('express');
const path = require('path');
const session = require('express-session');
const { google } = require('googleapis');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const moment = require('moment');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== GOOGLE SHEETS SETUP =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT;

let sheetsClient = null;
let googleReady = false;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  if (!SERVICE_ACCOUNT_KEY || !SPREADSHEET_ID) {
    console.log('⚠️ Google credentials not configured');
    return null;
  }

  try {
    const credentials = JSON.parse(SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    googleReady = true;
    console.log('✅ Google Sheets connected');
    return sheetsClient;
  } catch (err) {
    console.error('❌ Google Auth Error:', err.message);
    return null;
  }
}

// Sheet names (matching your original config)
const SHEETS = {
  LANDLORDS: 'Landlords',
  PROPERTIES: 'Properties',
  UNITS: 'Units',
  TENANTS: 'Tenants',
  RENT: 'Rent Collection',
  EXPENSES: 'Expenses',
  INVOICES: 'Invoices',
  USERS: 'Users',
  SETTINGS: 'Settings',
  AUDITLOG: 'AuditLog'
};

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pms-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===== PASSWORD HASHING (MATCHES APPS SCRIPT) =====
function hashPassword(password, salt = null) {
  if (!salt) {
    try { salt = crypto.randomUUID().substring(0, 8); }
    catch (e) { salt = crypto.randomBytes(4).toString('hex').substring(0, 8); }
  }
  const salted = password + salt;
  const hashHex = crypto.createHash('sha256').update(salted).digest('hex');
  return `${salt}:${hashHex}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt] = storedHash.split(':');
  return hashPassword(password, salt) === storedHash;
}

// ===== SHEET HELPERS =====
async function readSheet(sheetName) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return [];
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName
    });
    return res.data.values || [];
  } catch (err) {
    console.error('Error reading sheet', sheetName, ':', err.message);
    return [];
  }
}

async function appendToSheet(sheetName, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [values] }
    });
  } catch (err) {
    console.error('Error appending to sheet:', err.message);
  }
}

async function updateSheetRow(sheetName, rowIndex, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
  } catch (err) {
    console.error('Error updating sheet:', err.message);
  }
}

// ===== AUDIT LOG =====
async function logAudit(req, action, target, details) {
  const user = req.session || {};
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  await appendToSheet(SHEETS.AUDITLOG, [
    now, user.userId || 'SYSTEM', user.userName || 'Unknown', user.userRole || 'N/A',
    action, target, details || '', ip
  ]);
}

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

function requireRole(roles) {
  return (req, res, next) => {
    if (req.session && roles.includes(req.session.userRole)) return next();
    res.status(403).json({ success: false, message: 'Access denied' });
  };
}

// ===== ROUTES: AUTH =====
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null, title: 'Login' });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt for:', username);

    const data = await readSheet(SHEETS.USERS);
    console.log('Users sheet rows:', data.length);

    if (data.length < 2) {
      return res.render('login', { error: 'No users found', title: 'Login' });
    }

    const headers = data[0];
    const users = data.slice(1).map((row, idx) => {
      const obj = { _rowIndex: idx + 2 };
      headers.forEach((h, i) => obj[h] = row[i] || '');
      return obj;
    });

    const user = users.find(u => u.Username === username && u.Status === 'Active');
    if (!user) {
      return res.render('login', { error: 'Invalid username or password', title: 'Login' });
    }

    // Check password hash
    let valid = false;
    if (user['Password Hash'] && user['Password Hash'].includes(':')) {
      valid = verifyPassword(password, user['Password Hash']);
    } else {
      // Fallback for plain text passwords during transition
      valid = password === user['Password Hash'];
    }

    if (!valid) {
      return res.render('login', { error: 'Invalid username or password', title: 'Login' });
    }

    req.session.userId = user.UserID;
    req.session.userName = user['Full Name'];
    req.session.userRole = user.Role;

    // Update last login
    const now = moment().format('YYYY-MM-DD HH:mm:ss');
    await updateSheetRow(SHEETS.USERS, user._rowIndex, [
      user.UserID, user['Full Name'], user.Username, user['Password Hash'],
      user.Role, user.Email, user.Phone, user.Status, now, user['Created Date']
    ]);

    await logAudit(req, 'LOGIN', `User:${username}`, 'Successful login');
    res.redirect('/');

  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'System error: ' + err.message, title: 'Login' });
  }
});

app.get('/logout', async (req, res) => {
  await logAudit(req, 'LOGOUT', `User:${req.session?.userName || 'unknown'}`, 'Logout');
  req.session.destroy();
  res.redirect('/login');
});

// ===== ROUTES: DASHBOARD =====
app.get('/', requireAuth, async (req, res) => {
  try {
    const landlords = await readSheet(SHEETS.LANDLORDS);
    const properties = await readSheet(SHEETS.PROPERTIES);
    const units = await readSheet(SHEETS.UNITS);
    const tenants = await readSheet(SHEETS.TENANTS);
    const payments = await readSheet(SHEETS.RENT);
    const expenses = await readSheet(SHEETS.EXPENSES);

    const stats = {
      landlords: Math.max(0, landlords.length - 1),
      properties: Math.max(0, properties.length - 1),
      units: Math.max(0, units.length - 1),
      tenants: Math.max(0, tenants.length - 1),
      occupied: Math.max(0, tenants.length - 1),
      occRate: units.length > 1 ? Math.round(((tenants.length - 1) / (units.length - 1)) * 100) || 0 : 0,
      collected: payments.length > 1 ? payments.slice(1).reduce((s, r) => s + (parseFloat(r[3]) || 0), 0) : 0,
      expenses: expenses.length > 1 ? expenses.slice(1).reduce((s, e) => s + (parseFloat(e[5]) || 0), 0) : 0
    };

    res.render('dashboard', {
      title: 'Dashboard',
      user: {
        name: req.session.userName,
        role: req.session.userRole
      },
      stats: stats
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', {
      title: 'Dashboard',
      user: { name: req.session.userName, role: req.session.userRole },
      stats: { landlords: 0, properties: 0, units: 0, tenants: 0, occupied: 0, occRate: 0, collected: 0, expenses: 0 }
    });
  }
});

// ===== API: LANDLORDS =====
app.get('/api/landlords', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.LANDLORDS);
    const landlords = data.slice(1).map(row => ({
      id: row[0], name: row[1], phone: row[2], email: row[3],
      paymentMethod: row[4], status: row[5], notes: row[6] || ''
    }));
    res.json({ success: true, data: landlords });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/landlords', requireAuth, async (req, res) => {
  try {
    const id = 'LL-' + Date.now().toString(36).toUpperCase();
    const { name, phone, email, paymentMethod, status, notes } = req.body;
    await appendToSheet(SHEETS.LANDLORDS, [id, name, phone, email, paymentMethod, status || 'Active', notes || '']);
    await logAudit(req, 'CREATE', `Landlord:${id}`, `Created landlord ${name}`);
    res.json({ success: true, id, message: 'Landlord added' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: PROPERTIES =====
app.get('/api/properties', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.PROPERTIES);
    const properties = data.slice(1).map(row => ({
      id: row[0], name: row[1], type: row[2], landlordID: row[3],
      address: row[4] || '', city: row[5] || '', status: row[6] || 'Active',
      totalUnits: row[7] || 0, occupied: row[8] || 0
    }));
    res.json({ success: true, data: properties });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/properties', requireAuth, async (req, res) => {
  try {
    const id = 'PR-' + Date.now().toString(36).toUpperCase();
    const { name, type, landlordID, address, city, status } = req.body;
    await appendToSheet(SHEETS.PROPERTIES, [id, name, type, landlordID, address || '', city || '', status || 'Active', 0, 0]);
    await logAudit(req, 'CREATE', `Property:${id}`, `Created property ${name}`);
    res.json({ success: true, id, message: 'Property added' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: UNITS =====
app.get('/api/units', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.UNITS);
    const units = data.slice(1).map(row => ({
      id: row[0], propertyID: row[1], unitNumber: row[2], type: row[3],
      rent: row[4], status: row[5], tenantID: row[6] || '', tenantName: row[7] || ''
    }));
    res.json({ success: true, data: units });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: TENANTS =====
app.get('/api/tenants', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.TENANTS);
    const tenants = data.slice(1).map(row => ({
      id: row[0], unitID: row[1], name: row[2], phone: row[3],
      email: row[4] || '', start: row[5], end: row[6],
      emergency: row[7] || '', notes: row[8] || '',
      rent: row[9] || 0, arrears: row[10] || 0
    }));
    res.json({ success: true, data: tenants });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: EXPENSES =====
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.EXPENSES);
    const expenses = data.slice(1).map(row => ({
      id: row[0], date: row[1], propertyID: row[2], category: row[3],
      description: row[4], amount: row[5], paidTo: row[6] || '',
      paymentMethod: row[7] || '', reference: row[8] || '', notes: row[9] || ''
    }));
    res.json({ success: true, data: expenses });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: RENT COLLECTION =====
app.get('/api/rent', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.RENT);
    const rent = data.slice(1).map(row => ({
      id: row[0], date: row[1], tenantID: row[2], unitID: row[3],
      amount: row[4], method: row[5] || 'Cash', period: row[6] || '',
      receiptNo: row[7] || '', notes: row[8] || '', recordedBy: row[9] || ''
    }));
    res.json({ success: true, data: rent });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/rent', requireAuth, async (req, res) => {
  try {
    const id = 'PM-' + Date.now().toString(36).toUpperCase();
    const receiptNo = 'RCP-' + Date.now();
    const { tenantID, unitID, amount, date, method, period, notes } = req.body;
    const recorder = req.session.userName || 'System';
    await appendToSheet(SHEETS.RENT, [id, date || moment().format('YYYY-MM-DD'), tenantID, unitID, amount, method || 'Cash', period || moment().format('YYYY-MM'), receiptNo, notes || '', recorder]);
    await logAudit(req, 'CREATE', `Payment:${id}`, `Recorded payment $${amount}`);
    res.json({ success: true, id, receiptNo, message: 'Payment recorded' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== PDF RECEIPT =====
app.get('/receipt/:paymentId', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.RENT);
    const payment = data.slice(1).find(r => r[0] === req.params.paymentId);
    if (!payment) return res.status(404).send('Payment not found');

    const [tenants, units, properties] = await Promise.all([
      readSheet(SHEETS.TENANTS), readSheet(SHEETS.UNITS), readSheet(SHEETS.PROPERTIES)
    ]);

    const tenant = tenants.slice(1).find(t => t[0] === payment[2]) || [];
    const unit = units.slice(1).find(u => u[0] === payment[3]) || [];
    const property = properties.slice(1).find(p => p[0] === (unit[1] || '')) || [];

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Receipt-${payment[7] || 'RCP'}.pdf"`);
    doc.pipe(res);

    doc.fontSize(24).fillColor('#0f766e').text('OFFICIAL RECEIPT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666').text('Property Management System', { align: 'center' });
    doc.moveDown(1);

    doc.rect(50, doc.y, 500, 80).stroke('#0f766e');
    doc.fontSize(12).fillColor('#000').text(`Receipt No: ${payment[7] || 'N/A'}`, 70, doc.y + 15);
    doc.text(`Date: ${moment(payment[1]).format('MMMM Do YYYY')}`);
    doc.text(`Payment Method: ${payment[5] || 'Cash'}`);
    doc.moveDown(2);

    doc.fontSize(14).fillColor('#0f766e').text('Received From:');
    doc.fontSize(12).fillColor('#000').text(tenant[2] || 'N/A');
    doc.text(`Property: ${property[1] || 'N/A'} - Unit ${unit[2] || 'N/A'}`);
    doc.moveDown(1);

    doc.rect(50, doc.y, 500, 60).fill('#f0fdfa').stroke('#ccfbf1');
    doc.fillColor('#000').fontSize(16).text(`Amount Paid: $${parseFloat(payment[4]).toFixed(2)}`, 70, doc.y - 45);
    doc.fontSize(11).text(`For Period: ${payment[6] || 'N/A'}`, 70, doc.y + 5);
    doc.moveDown(2);

    if (payment[8]) {
      doc.fontSize(11).text(`Notes: ${payment[8]}`);
      doc.moveDown(1);
    }

    doc.moveDown(2);
    doc.fontSize(10).fillColor('#666').text('Thank you for your payment!', { align: 'center' });
    doc.text(`Processed by: ${req.session.userName} on ${moment().format('YYYY-MM-DD HH:mm')}`, { align: 'center' });

    doc.end();
  } catch (err) {
    res.status(500).send('Error generating receipt: ' + err.message);
  }
});

// ===== API: SETTINGS =====
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.SETTINGS);
    const settings = {};
    data.slice(1).forEach(row => { settings[row[0]] = row[1]; });
    res.json({ success: true, data: settings });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== API: AUDIT LOG (Admin only) =====
app.get('/api/audit-log', requireAuth, requireRole(['Admin', 'Manager']), async (req, res) => {
  try {
    const data = await readSheet(SHEETS.AUDITLOG);
    const logs = data.slice(1).map(row => ({
      timestamp: row[0], userId: row[1], userName: row[2], role: row[3],
      action: row[4], target: row[5], details: row[6], ip: row[7]
    })).reverse();
    res.json({ success: true, data: logs });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Server error');
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`PMS Server running on port ${PORT}`);
  console.log(`Google Sheets: ${googleReady ? '✅ Connected' : '⏳ Waiting for first request'}`);
});
