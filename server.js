const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== GOOGLE SHEETS SETUP =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'YOUR_SPREADSHEET_ID_HERE';
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  let auth;
  if (SERVICE_ACCOUNT_KEY) {
    // Production: use service account JSON from env
    const credentials = JSON.parse(SERVICE_ACCOUNT_KEY);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    // Development: use local credentials file
    auth = new google.auth.GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

// Sheet names (matching your Apps Script config)
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
  SESSIONS: 'Sessions'
};

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pms-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===== HELPERS =====
function generateID(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function readSheet(sheetName) {
  try {
    const sheets = await getSheetsClient();
    console.log('Reading sheet:', sheetName, 'from spreadsheet:', SPREADSHEET_ID);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName
    });
    console.log('Sheet read success:', sheetName, 'rows:', (res.data.values || []).length);
    return res.data.values || [];
  } catch (err) {
    console.error('Error reading sheet', sheetName, ':', err.message);
    throw err;
  }
}
async function appendToSheet(sheetName, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [values] }
  });
}

async function updateSheetRow(sheetName, rowIndex, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] }
  });
}

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.redirect('/login');
}

// ===== ROUTES =====

// Login page
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});

// Login POST
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('Login attempt for:', username);

    const data = await readSheet(SHEETS.USERS);
    console.log('Users sheet rows:', data.length);

    if (data.length < 2) {
      console.log('Users sheet is empty or has no data rows');
      return res.render('login', { error: 'No users found in database' });
    }

    const users = data.slice(1);
    console.log('First user row:', users[0]);
    console.log('Sheet headers:', data[0]);

    // Find user by username (column C = index 2)
    const user = users.find(u => u[2] === username);
    if (!user) {
      console.log('User not found:', username);
      return res.render('login', { error: 'Invalid username or password' });
    }

    console.log('Found user:', user);
    console.log('UserID:', user[0], 'Name:', user[1], 'Role:', user[4]);

    // TEMPORARY BYPASS: Accept any password for testing
    console.log('⚠️ PASSWORD BYPASS ACTIVE - accepting any password for testing');
    req.session.userId = user[0];
    req.session.userName = user[1];
    req.session.userRole = user[4];
    console.log('Session created:', { userId: user[0], userName: user[1], userRole: user[4] });
    return res.redirect('/');

  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { error: 'System error: ' + err.message });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard (protected)
app.get('/', requireAuth, async (req, res) => {
  try {
    // Get stats
    const landlords = await readSheet(SHEETS.LANDLORDS);
    const properties = await readSheet(SHEETS.PROPERTIES);
    const units = await readSheet(SHEETS.UNITS);
    const tenants = await readSheet(SHEETS.TENANTS);

    const stats = {
      landlords: landlords.length > 1 ? landlords.length - 1 : 0,
      properties: properties.length > 1 ? properties.length - 1 : 0,
      units: units.length > 1 ? units.length - 1 : 0,
      tenants: tenants.length > 1 ? tenants.length - 1 : 0,
      occupied: tenants.length > 1 ? tenants.length - 1 : 0,
      occRate: properties.length > 1 ? Math.round(((tenants.length - 1) / (units.length - 1)) * 100) || 0 : 0
    };

    res.render('dashboard', {
      user: {
        name: req.session.userName,
        role: req.session.userRole
      },
      stats: stats
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('dashboard', {
      user: { name: req.session.userName, role: req.session.userRole },
      stats: { landlords: 0, properties: 0, units: 0, tenants: 0, occupied: 0, occRate: 0 }
    });
  }
});

// API: Get landlords
app.get('/api/landlords', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.LANDLORDS);
    const landlords = data.slice(1).map(row => ({
      id: row[0],
      name: row[1],
      phone: row[2],
      email: row[3],
      paymentMethod: row[4],
      status: row[5],
      notes: row[6] || ''
    }));
    res.json({ success: true, data: landlords });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Add landlord
app.post('/api/landlords', requireAuth, async (req, res) => {
  try {
    const id = generateID('LL');
    const { name, phone, email, paymentMethod, status, notes } = req.body;
    await appendToSheet(SHEETS.LANDLORDS, [id, name, phone, email, paymentMethod, status || 'Active', notes || '']);
    res.json({ success: true, id, message: 'Landlord added successfully' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Get properties
app.get('/api/properties', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.PROPERTIES);
    const properties = data.slice(1).map(row => ({
      id: row[0],
      name: row[1],
      type: row[2],
      landlordID: row[3],
      address: row[4] || '',
      city: row[5] || '',
      status: row[6] || 'Active',
      totalUnits: row[7] || 0,
      occupied: row[8] || 0
    }));
    res.json({ success: true, data: properties });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Add property
app.post('/api/properties', requireAuth, async (req, res) => {
  try {
    const id = generateID('PR');
    const { name, type, landlordID, address, city, status } = req.body;
    await appendToSheet(SHEETS.PROPERTIES, [id, name, type, landlordID, address || '', city || '', status || 'Active', 0, 0]);
    res.json({ success: true, id, message: 'Property added successfully' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Get units
app.get('/api/units', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.UNITS);
    const units = data.slice(1).map(row => ({
      id: row[0],
      propertyID: row[1],
      unitNumber: row[2],
      type: row[3],
      rent: row[4],
      status: row[5],
      tenantID: row[6] || '',
      tenantName: row[7] || ''
    }));
    res.json({ success: true, data: units });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Get tenants
app.get('/api/tenants', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.TENANTS);
    const tenants = data.slice(1).map(row => ({
      id: row[0],
      unitID: row[1],
      name: row[2],
      phone: row[3],
      email: row[4] || '',
      start: row[5],
      end: row[6],
      emergency: row[7] || '',
      notes: row[8] || '',
      rent: row[9] || 0,
      arrears: row[10] || 0
    }));
    res.json({ success: true, data: tenants });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Get expenses
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.EXPENSES);
    const expenses = data.slice(1).map(row => ({
      id: row[0],
      date: row[1],
      propertyID: row[2],
      category: row[3],
      description: row[4],
      amount: row[5],
      paidTo: row[6] || '',
      paymentMethod: row[7] || '',
      reference: row[8] || '',
      notes: row[9] || ''
    }));
    res.json({ success: true, data: expenses });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// API: Get settings
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const data = await readSheet(SHEETS.SETTINGS);
    const settings = {};
    data.slice(1).forEach(row => {
      settings[row[0]] = row[1];
    });
    res.json({ success: true, data: settings });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`PMS Server running on port ${PORT}`);
  console.log(`Spreadsheet ID: ${SPREADSHEET_ID}`);
});
