const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const methodOverride = require('method-override');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ====== MIDDLEWARE ======
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'pms-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ====== GOOGLE SHEETS SETUP (WITH CRASH PROTECTION) ======
let sheets;
let SPREADSHEET_ID;
let googleAuthReady = false;

try {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT env var is missing');
  }
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
  SPREADSHEET_ID = process.env.SPREADSHEET_ID;
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID env var is missing');
  }
  googleAuthReady = true;
  console.log('✅ Google Sheets connected');
} catch (e) {
  console.error('❌ Google Auth Error:', e.message);
  googleAuthReady = false;
}

// ====== PASSWORD HASHING (MATCHES APPS SCRIPT EXACTLY) ======
function hashPassword(password, salt = null) {
  if (!salt) {
    try {
      salt = crypto.randomUUID().substring(0, 8);
    } catch (e) {
      salt = crypto.randomBytes(4).toString('hex').substring(0, 8);
    }
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

// ====== SHEETS HELPERS (ROBUST) ======
async function getSheetData(sheetName) {
  if (!googleAuthReady) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:Z1000`
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    return rows.slice(1).map((row, idx) => {
      const obj = { _rowIndex: idx + 2 };
      headers.forEach((h, i) => obj[h] = row[i] || '');
      return obj;
    });
  } catch (e) {
    console.error(`Error reading ${sheetName}:`, e.message);
    return [];
  }
}

async function appendRow(sheetName, values) {
  if (!googleAuthReady) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [values] }
    });
  } catch (e) {
    console.error(`Error appending to ${sheetName}:`, e.message);
  }
}

async function updateRow(sheetName, rowIndex, values) {
  if (!googleAuthReady) return;
  try {
    const range = `${sheetName}!A${rowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      resource: { values: [values] }
    });
  } catch (e) {
    console.error(`Error updating ${sheetName}:`, e.message);
  }
}

async function deleteRow(sheetName, rowIndex) {
  if (!googleAuthReady) return;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: await getSheetId(sheetName),
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex
            }
          }
        }]
      }
    });
  } catch (e) {
    console.error(`Error deleting from ${sheetName}:`, e.message);
  }
}

async function getSheetId(sheetName) {
  if (!googleAuthReady) return null;
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

// ====== AUDIT LOG ======
async function logAudit(req, action, target, details) {
  const user = req.session.user || {};
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  await appendRow('AuditLog', [
    now,
    user.UserID || 'SYSTEM',
    user.FullName || 'Unknown',
    user.Role || 'N/A',
    action,
    target,
    details || '',
    ip
  ]);
}

// ====== AUTH MIDDLEWARE ======
const requireAuth = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

const requireRole = (roles) => (req, res, next) => {
  if (req.session.user && roles.includes(req.session.user.Role)) return next();
  res.status(403).send('Access Denied');
};

// ====== ENV CHECK MIDDLEWARE ======
const checkEnv = (req, res, next) => {
  if (!googleAuthReady) {
    return res.status(500).render('error', {
      title: 'Setup Error',
      user: req.session.user || null,
      message: 'Google Sheets not connected. Please check your environment variables (GOOGLE_SERVICE_ACCOUNT and SPREADSHEET_ID) in Render dashboard.'
    });
  }
  next();
};

// ====== ROUTES: AUTH ======
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, title: 'Login' });
});

app.post('/login', checkEnv, async (req, res) => {
  const { username, password } = req.body;
  const users = await getSheetData('Users');
  const user = users.find(u => u.Username === username && u.Status === 'Active');

  if (!user) return res.render('login', { error: 'Invalid credentials', title: 'Login' });

  let valid = false;
  if (user['Password Hash'] && user['Password Hash'].includes(':')) {
    valid = verifyPassword(password, user['Password Hash']);
  } else {
    valid = password === user['Password Hash'];
  }

  if (!valid) return res.render('login', { error: 'Invalid credentials', title: 'Login' });

  req.session.user = {
    UserID: user.UserID,
    FullName: user['Full Name'],
    Username: user.Username,
    Role: user.Role,
    Email: user.Email
  };

  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await updateRow('Users', user._rowIndex, [
    user.UserID, user['Full Name'], user.Username, user['Password Hash'],
    user.Role, user.Email, user.Phone, user.Status, now, user['Created Date']
  ]);

  await logAudit(req, 'LOGIN', `User:${user.Username}`, 'Successful login');
  res.redirect('/dashboard');
});

app.get('/logout', async (req, res) => {
  await logAudit(req, 'LOGOUT', `User:${req.session.user?.Username || 'unknown'}`, 'Logout');
  req.session.destroy();
  res.redirect('/login');
});

// ====== ROUTES: DASHBOARD ======
app.get('/dashboard', requireAuth, checkEnv, async (req, res) => {
  const [landlords, properties, units, tenants, payments, expenses] = await Promise.all([
    getSheetData('Landlords'),
    getSheetData('Properties'),
    getSheetData('Units'),
    getSheetData('Tenants'),
    getSheetData('Rent Collection'),
    getSheetData('Expenses')
  ]);

  const activeTenants = tenants.filter(t => t.Status === 'Active').length;
  const occupiedUnits = units.filter(u => u.Status === 'Occupied').length;
  const totalUnits = units.length;
  const monthlyRent = units.reduce((sum, u) => sum + (parseFloat(u.RentAmount || u['Monthly Rent'] || u.rent || 0)), 0);
  const totalCollected = payments.reduce((sum, p) => sum + (parseFloat(p.Amount || p.amount || 0)), 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + (parseFloat(e.Amount || e.amount || 0)), 0);

  const recentPayments = payments
    .sort((a, b) => new Date(b['Created Date'] || b.Date || 0) - new Date(a['Created Date'] || a.Date || 0))
    .slice(0, 5);

  res.render('dashboard', {
    title: 'Dashboard',
    user: req.session.user,
    stats: {
      landlords: landlords.length,
      properties: properties.length,
      units: totalUnits,
      occupied: occupiedUnits,
      tenants: activeTenants,
      monthlyRent,
      collected: totalCollected,
      expenses: totalExpenses,
      balance: totalCollected - totalExpenses
    },
    recentPayments,
    landlords, properties, units, tenants
  });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ====== ROUTES: LANDLORDS (CRUD) ======
app.get('/landlords', requireAuth, checkEnv, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  res.render('landlords', { title: 'Landlords', user: req.session.user, landlords, error: null });
});

app.post('/landlords', requireAuth, checkEnv, async (req, res) => {
  const { fullName, email, phone, shortCode } = req.body;
  const id = 'LL' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Landlords', [id, fullName, email, phone, shortCode || '', 'Active', now]);
  await logAudit(req, 'CREATE', `Landlord:${id}`, `Created landlord ${fullName}`);
  res.redirect('/landlords');
});

app.put('/landlords/:id', requireAuth, checkEnv, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  const landlord = landlords.find(l => l.LandlordID === req.params.id);
  if (!landlord) return res.status(404).send('Not found');

  const { fullName, email, phone, shortCode, status } = req.body;
  await updateRow('Landlords', landlord._rowIndex, [
    landlord.LandlordID, fullName, email, phone, shortCode || landlord.ShortCode || '', status || 'Active', landlord['Created Date']
  ]);
  await logAudit(req, 'UPDATE', `Landlord:${req.params.id}`, `Updated landlord ${fullName}`);
  res.redirect('/landlords');
});

app.delete('/landlords/:id', requireAuth, checkEnv, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  const landlord = landlords.find(l => l.LandlordID === req.params.id);
  if (landlord) {
    await deleteRow('Landlords', landlord._rowIndex);
    await logAudit(req, 'DELETE', `Landlord:${req.params.id}`, 'Deleted landlord');
  }
  res.redirect('/landlords');
});

// ====== ROUTES: PROPERTIES (CRUD) ======
app.get('/properties', requireAuth, checkEnv, async (req, res) => {
  const [properties, landlords] = await Promise.all([getSheetData('Properties'), getSheetData('Landlords')]);
  res.render('properties', { title: 'Properties', user: req.session.user, properties, landlords, error: null });
});

app.post('/properties', requireAuth, checkEnv, async (req, res) => {
  const { propertyName, address, landlordId, shortCode, type } = req.body;
  const id = 'PR' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Properties', [id, propertyName, address, landlordId, shortCode || '', type || 'Residential', 'Active', now]);
  await logAudit(req, 'CREATE', `Property:${id}`, `Created property ${propertyName}`);
  res.redirect('/properties');
});

app.put('/properties/:id', requireAuth, checkEnv, async (req, res) => {
  const properties = await getSheetData('Properties');
  const prop = properties.find(p => p.PropertyID === req.params.id);
  if (!prop) return res.status(404).send('Not found');

  const { propertyName, address, landlordId, shortCode, type, status } = req.body;
  await updateRow('Properties', prop._rowIndex, [
    prop.PropertyID, propertyName, address, landlordId, shortCode || prop.ShortCode || '', type || prop.Type, status || 'Active', prop['Created Date']
  ]);
  await logAudit(req, 'UPDATE', `Property:${req.params.id}`, `Updated property ${propertyName}`);
  res.redirect('/properties');
});

app.delete('/properties/:id', requireAuth, checkEnv, async (req, res) => {
  const properties = await getSheetData('Properties');
  const prop = properties.find(p => p.PropertyID === req.params.id);
  if (prop) {
    await deleteRow('Properties', prop._rowIndex);
    await logAudit(req, 'DELETE', `Property:${req.params.id}`, 'Deleted property');
  }
  res.redirect('/properties');
});

// ====== ROUTES: UNITS (CRUD) ======
app.get('/units', requireAuth, checkEnv, async (req, res) => {
  const [units, properties] = await Promise.all([getSheetData('Units'), getSheetData('Properties')]);
  res.render('units', { title: 'Units', user: req.session.user, units, properties, error: null });
});

app.post('/units', requireAuth, checkEnv, async (req, res) => {
  const { propertyId, unitNumber, unitType, rentAmount } = req.body;
  const id = 'UN' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Units', [id, propertyId, unitNumber, unitType || 'Standard', rentAmount, 'Vacant', now]);
  await logAudit(req, 'CREATE', `Unit:${id}`, `Created unit ${unitNumber}`);
  res.redirect('/units');
});

app.put('/units/:id', requireAuth, checkEnv, async (req, res) => {
  const units = await getSheetData('Units');
  const unit = units.find(u => u.UnitID === req.params.id);
  if (!unit) return res.status(404).send('Not found');

  const { propertyId, unitNumber, unitType, rentAmount, status } = req.body;
  await updateRow('Units', unit._rowIndex, [
    unit.UnitID, propertyId, unitNumber, unitType || unit.UnitType, rentAmount, status || unit.Status, unit['Created Date']
  ]);
  await logAudit(req, 'UPDATE', `Unit:${req.params.id}`, `Updated unit ${unitNumber}`);
  res.redirect('/units');
});

app.delete('/units/:id', requireAuth, checkEnv, async (req, res) => {
  const units = await getSheetData('Units');
  const unit = units.find(u => u.UnitID === req.params.id);
  if (unit) {
    await deleteRow('Units', unit._rowIndex);
    await logAudit(req, 'DELETE', `Unit:${req.params.id}`, 'Deleted unit');
  }
  res.redirect('/units');
});

// ====== ROUTES: TENANTS (CRUD) ======
app.get('/tenants', requireAuth, checkEnv, async (req, res) => {
  const [tenants, units] = await Promise.all([getSheetData('Tenants'), getSheetData('Units')]);
  res.render('tenants', { title: 'Tenants', user: req.session.user, tenants, units, error: null });
});

app.post('/tenants', requireAuth, checkEnv, async (req, res) => {
  const { fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit } = req.body;
  const id = 'TN' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Tenants', [id, fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit || '0', 'Active', now]);

  const units = await getSheetData('Units');
  const unit = units.find(u => u.UnitID === unitId);
  if (unit) {
    await updateRow('Units', unit._rowIndex, [
      unit.UnitID, unit.PropertyID, unit.UnitNumber, unit.UnitType, unit.RentAmount, 'Occupied', unit['Created Date']
    ]);
  }
  await logAudit(req, 'CREATE', `Tenant:${id}`, `Created tenant ${fullName}`);
  res.redirect('/tenants');
});

app.put('/tenants/:id', requireAuth, checkEnv, async (req, res) => {
  const tenants = await getSheetData('Tenants');
  const tenant = tenants.find(t => t.TenantID === req.params.id);
  if (!tenant) return res.status(404).send('Not found');

  const { fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit, status } = req.body;
  await updateRow('Tenants', tenant._rowIndex, [
    tenant.TenantID, fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit || tenant.Deposit, status || 'Active', tenant['Created Date']
  ]);
  await logAudit(req, 'UPDATE', `Tenant:${req.params.id}`, `Updated tenant ${fullName}`);
  res.redirect('/tenants');
});

app.delete('/tenants/:id', requireAuth, checkEnv, async (req, res) => {
  const tenants = await getSheetData('Tenants');
  const tenant = tenants.find(t => t.TenantID === req.params.id);
  if (tenant) {
    await deleteRow('Tenants', tenant._rowIndex);
    const units = await getSheetData('Units');
    const unit = units.find(u => u.UnitID === tenant.UnitID);
    if (unit) {
      await updateRow('Units', unit._rowIndex, [
        unit.UnitID, unit.PropertyID, unit.UnitNumber, unit.UnitType, unit.RentAmount, 'Vacant', unit['Created Date']
      ]);
    }
    await logAudit(req, 'DELETE', `Tenant:${req.params.id}`, 'Deleted tenant');
  }
  res.redirect('/tenants');
});

// ====== ROUTES: RENT COLLECTION (PAYMENTS) + RECEIPTS ======
app.get('/payments', requireAuth, checkEnv, async (req, res) => {
  const [payments, tenants, units] = await Promise.all([
    getSheetData('Rent Collection'), getSheetData('Tenants'), getSheetData('Units')
  ]);
  res.render('payments', { title: 'Rent Payments', user: req.session.user, payments, tenants, units, error: null });
});

app.post('/payments', requireAuth, checkEnv, async (req, res) => {
  const { tenantId, amount, paymentDate, paymentMethod, period, notes, recordedBy } = req.body;
  const id = 'PM' + Date.now();
  const receiptNo = 'RCP-' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  const tenants = await getSheetData('Tenants');
  const tenant = tenants.find(t => t.TenantID === tenantId);
  const unitId = tenant ? tenant.UnitID : '';
  const recorder = recordedBy || req.session.user.FullName;

  await appendRow('Rent Collection', [id, tenantId, unitId, amount, paymentDate, paymentMethod || 'Cash', period, receiptNo, notes || '', recorder, now]);
  await logAudit(req, 'CREATE', `Payment:${id}`, `Recorded payment $${amount} for tenant ${tenantId}`);
  res.redirect('/payments');
});

// PDF RECEIPT GENERATOR
app.get('/receipt/:paymentId', requireAuth, checkEnv, async (req, res) => {
  const payments = await getSheetData('Rent Collection');
  const payment = payments.find(p => p.PaymentID === req.params.paymentId || p.paymentId === req.params.paymentId);
  if (!payment) return res.status(404).send('Payment not found');

  const [tenants, units, properties] = await Promise.all([
    getSheetData('Tenants'), getSheetData('Units'), getSheetData('Properties')
  ]);

  const tenant = tenants.find(t => t.TenantID === (payment.TenantID || payment.tenantId)) || {};
  const unit = units.find(u => u.UnitID === (payment.UnitID || payment.unitId)) || {};
  const property = properties.find(p => p.PropertyID === unit.PropertyID) || {};

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Receipt-${payment.ReceiptNo || payment.receiptNo || 'RCP'}.pdf"`);
  doc.pipe(res);

  doc.fontSize(24).fillColor('#1a237e').text('OFFICIAL RECEIPT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#666').text('Property Management System', { align: 'center' });
  doc.moveDown(1);

  doc.rect(50, doc.y, 500, 80).stroke('#1a237e');
  doc.fontSize(12).fillColor('#000').text(`Receipt No: ${payment.ReceiptNo || payment.receiptNo || 'N/A'}`, 70, doc.y + 15);
  doc.text(`Date: ${moment(payment.PaymentDate || payment.paymentDate).format('MMMM Do YYYY')}`);
  doc.text(`Payment Method: ${payment.PaymentMethod || payment.paymentMethod || 'Cash'}`);
  doc.moveDown(2);

  doc.fontSize(14).fillColor('#1a237e').text('Received From:');
  doc.fontSize(12).fillColor('#000').text(tenant.FullName || 'N/A');
  doc.text(`Property: ${property.PropertyName || 'N/A'} - Unit ${unit.UnitNumber || 'N/A'}`);
  doc.moveDown(1);

  doc.rect(50, doc.y, 500, 60).fill('#f5f5f5').stroke('#ddd');
  doc.fillColor('#000').fontSize(16).text(`Amount Paid: $${parseFloat(payment.Amount || payment.amount).toFixed(2)}`, 70, doc.y - 45);
  doc.fontSize(11).text(`For Period: ${payment.Period || payment.period || 'N/A'}`, 70, doc.y + 5);
  doc.moveDown(2);

  if (payment.Notes || payment.notes) {
    doc.fontSize(11).text(`Notes: ${payment.Notes || payment.notes}`);
    doc.moveDown(1);
  }

  doc.moveDown(2);
  doc.fontSize(10).fillColor('#666').text('Thank you for your payment!', { align: 'center' });
  doc.text(`Processed by: ${req.session.user.FullName} on ${moment().format('YYYY-MM-DD HH:mm')}`, { align: 'center' });

  doc.end();
});

// ====== ROUTES: EXPENSES ======
app.get('/expenses', requireAuth, checkEnv, async (req, res) => {
  const [expenses, properties] = await Promise.all([getSheetData('Expenses'), getSheetData('Properties')]);
  res.render('expenses', { title: 'Expenses', user: req.session.user, expenses, properties, error: null });
});

app.post('/expenses', requireAuth, checkEnv, async (req, res) => {
  const { propertyId, category, amount, date, description, receiptNo } = req.body;
  const id = 'EX' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Expenses', [id, propertyId, category, amount, date, description, receiptNo || '', now]);
  await logAudit(req, 'CREATE', `Expense:${id}`, `Recorded expense $${amount} for ${category}`);
  res.redirect('/expenses');
});

app.delete('/expenses/:id', requireAuth, checkEnv, async (req, res) => {
  const expenses = await getSheetData('Expenses');
  const exp = expenses.find(e => e.ExpenseID === req.params.id);
  if (exp) {
    await deleteRow('Expenses', exp._rowIndex);
    await logAudit(req, 'DELETE', `Expense:${req.params.id}`, 'Deleted expense');
  }
  res.redirect('/expenses');
});

// ====== ROUTES: INVOICES (WITH TYPE) ======
app.get('/invoices', requireAuth, checkEnv, async (req, res) => {
  const [invoices, landlords, properties, tenants] = await Promise.all([
    getSheetData('Invoices'), getSheetData('Landlords'), getSheetData('Properties'), getSheetData('Tenants')
  ]);
  res.render('invoices', { title: 'Invoices', user: req.session.user, invoices, landlords, properties, tenants, error: null });
});

app.post('/invoices/generate', requireAuth, checkEnv, async (req, res) => {
  const { type, landlordId, tenantId, period, propertyId } = req.body;
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  if (type === 'Management Fee') {
    const landlords = await getSheetData('Landlords');
    const properties = await getSheetData('Properties');
    const units = await getSheetData('Units');
    const payments = await getSheetData('Rent Collection');

    const landlord = landlords.find(l => l.LandlordID === landlordId);
    if (!landlord) return res.redirect('/invoices');

    const landlordProps = properties.filter(p => p.LandlordID === landlordId);
    const propIds = landlordProps.map(p => p.PropertyID);
    const landlordUnits = units.filter(u => propIds.includes(u.PropertyID));
    const unitIds = landlordUnits.map(u => u.UnitID);

    const periodPayments = payments.filter(p => {
      return unitIds.includes(p.UnitID || p.unitId) && (p.Period || p.period) === period;
    });

    const totalCollected = periodPayments.reduce((sum, p) => sum + (parseFloat(p.Amount || p.amount) || 0), 0);
    const feePercent = parseFloat(landlord['Management Fee'] || landlord.managementFee || 10);
    const feeAmount = (totalCollected * feePercent / 100).toFixed(2);
    const netAmount = (totalCollected - feeAmount).toFixed(2);

    const id = 'INV' + Date.now();
    const invoiceNo = 'INV-MGT-' + moment().format('YYYYMM') + '-' + Math.floor(Math.random() * 1000);

    await appendRow('Invoices', [id, 'Management Fee', landlordId, '', period, feePercent, feeAmount, netAmount, 'Pending', now, invoiceNo, totalCollected]);
    await logAudit(req, 'CREATE', `Invoice:${id}`, `Generated management fee invoice for ${landlord.FullName}`);
  } else if (type === 'Rent Invoice') {
    const tenants = await getSheetData('Tenants');
    const tenant = tenants.find(t => t.TenantID === tenantId);
    if (!tenant) return res.redirect('/invoices');

    const rentAmount = parseFloat(tenant.RentAmount || tenant.rent || 0).toFixed(2);
    const id = 'INV' + Date.now();
    const invoiceNo = 'INV-RNT-' + moment().format('YYYYMM') + '-' + Math.floor(Math.random() * 1000);

    await appendRow('Invoices', [id, 'Rent Invoice', '', tenantId, period, '0', '0', rentAmount, 'Pending', now, invoiceNo, rentAmount]);
    await logAudit(req, 'CREATE', `Invoice:${id}`, `Generated rent invoice for ${tenant.FullName}`);
  }

  res.redirect('/invoices');
});

// PDF INVOICE GENERATOR
app.get('/invoice/:invoiceId/pdf', requireAuth, checkEnv, async (req, res) => {
  const invoices = await getSheetData('Invoices');
  const invoice = invoices.find(i => i.InvoiceID === req.params.invoiceId);
  if (!invoice) return res.status(404).send('Invoice not found');

  const [landlords, properties, units, tenants, payments] = await Promise.all([
    getSheetData('Landlords'), getSheetData('Properties'), getSheetData('Units'), getSheetData('Tenants'), getSheetData('Rent Collection')
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Invoice-${invoice.InvoiceNo || invoice.invoiceNo}.pdf"`);
  doc.pipe(res);

  if (invoice.Type === 'Management Fee' || invoice.type === 'Management Fee') {
    const landlord = landlords.find(l => l.LandlordID === invoice.LandlordID) || {};
    const property = properties.find(p => p.PropertyID === invoice.PropertyID) || {};

    const landlordProps = properties.filter(p => p.LandlordID === invoice.LandlordID);
    const propIds = landlordProps.map(p => p.PropertyID);
    const landlordUnits = units.filter(u => propIds.includes(u.PropertyID));
    const unitIds = landlordUnits.map(u => u.UnitID);
    const periodPayments = payments.filter(p => unitIds.includes(p.UnitID || p.unitId) && (p.Period || p.period) === invoice.Period);

    doc.fontSize(28).fillColor('#1a237e').text('MANAGEMENT FEE INVOICE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#666').text('Property Management Services', { align: 'center' });
    doc.moveDown(1.5);

    doc.rect(50, doc.y, 500, 90).stroke('#1a237e');
    let y = doc.y + 15;
    doc.fontSize(11).fillColor('#000').text(`Invoice No: ${invoice.InvoiceNo || invoice.invoiceNo}`, 70, y);
    doc.text(`Date: ${moment(invoice['Created Date'] || invoice.createdDate).format('MMMM Do YYYY')}`, 300, y);
    y += 20;
    doc.text(`Period: ${invoice.Period || invoice.period}`, 70, y);
    doc.text(`Status: ${invoice.Status || invoice.status}`, 300, y);
    y += 20;
    doc.text(`Landlord: ${landlord.FullName || 'N/A'}`, 70, y);
    if (property.PropertyName) doc.text(`Property: ${property.PropertyName}`, 300, y);
    doc.moveDown(3);

    doc.fontSize(14).fillColor('#1a237e').text('Rent Collections This Period:');
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#fff');
    doc.rect(50, doc.y, 500, 20).fill('#1a237e');
    doc.text('Date', 60, doc.y - 15);
    doc.text('Tenant', 150, doc.y - 15);
    doc.text('Unit', 280, doc.y - 15);
    doc.text('Amount', 420, doc.y - 15);
    doc.moveDown(0.3);

    doc.fillColor('#000');
    let total = 0;
    periodPayments.forEach(p => {
      doc.text(p.PaymentDate || p.paymentDate, 60, doc.y);
      doc.text(p.TenantID || p.tenantId, 150, doc.y);
      doc.text(p.UnitID || p.unitId, 280, doc.y);
      doc.text(`$${parseFloat(p.Amount || p.amount || 0).toFixed(2)}`, 420, doc.y);
      total += parseFloat(p.Amount || p.amount || 0);
      doc.moveDown(0.5);
    });

    doc.moveDown(1);
    doc.rect(300, doc.y, 250, 80).stroke('#ddd');
    doc.fontSize(11).text(`Total Collected: $${total.toFixed(2)}`, 320, doc.y + 10);
    doc.text(`Management Fee (${invoice['Management Fee'] || invoice.managementFee}%): $${invoice['Fee Amount'] || invoice.feeAmount}`, 320, doc.y + 5);
    doc.fontSize(14).fillColor('#1a237e').text(`NET PAYABLE: $${invoice['Net Amount'] || invoice.netAmount}`, 320, doc.y + 10);

    doc.moveDown(3);
    doc.fontSize(10).fillColor('#666').text('Please process payment within 30 days. Thank you for your business.', { align: 'center' });
  } else {
    const tenant = tenants.find(t => t.TenantID === invoice.TenantID) || {};
    const unit = units.find(u => u.UnitID === tenant.UnitID) || {};
    const property = properties.find(p => p.PropertyID === unit.PropertyID) || {};

    doc.fontSize(28).fillColor('#1a237e').text('RENT INVOICE', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#666').text('Property Management Services', { align: 'center' });
    doc.moveDown(1.5);

    doc.rect(50, doc.y, 500, 90).stroke('#1a237e');
    let y = doc.y + 15;
    doc.fontSize(11).fillColor('#000').text(`Invoice No: ${invoice.InvoiceNo || invoice.invoiceNo}`, 70, y);
    doc.text(`Date: ${moment(invoice['Created Date'] || invoice.createdDate).format('MMMM Do YYYY')}`, 300, y);
    y += 20;
    doc.text(`Period: ${invoice.Period || invoice.period}`, 70, y);
    doc.text(`Status: ${invoice.Status || invoice.status}`, 300, y);
    y += 20;
    doc.text(`Tenant: ${tenant.FullName || 'N/A'}`, 70, y);
    doc.text(`Property: ${property.PropertyName || 'N/A'}`, 300, y);
    doc.moveDown(3);

    doc.fontSize(14).fillColor('#1a237e').text('Rent Due:');
    doc.moveDown(1);

    doc.rect(50, doc.y, 500, 60).fill('#f5f5f5').stroke('#ddd');
    doc.fillColor('#000').fontSize(16).text(`Monthly Rent: $${parseFloat(invoice['Net Amount'] || invoice.netAmount || 0).toFixed(2)}`, 70, doc.y - 45);
    doc.fontSize(11).text(`Unit: ${unit.UnitNumber || 'N/A'}`, 70, doc.y + 5);
    doc.moveDown(3);
    doc.fontSize(10).fillColor('#666').text('Please pay by the due date to avoid late fees.', { align: 'center' });
  }

  doc.end();
});

// ====== ROUTES: ARREARS ======
app.get('/arrears', requireAuth, checkEnv, async (req, res) => {
  const [tenants, units, payments] = await Promise.all([
    getSheetData('Tenants'), getSheetData('Units'), getSheetData('Rent Collection')
  ]);

  const currentMonth = moment().format('YYYY-MM');
  const arrears = tenants.filter(t => t.Status === 'Active').map(t => {
    const unit = units.find(u => u.UnitID === t.UnitID) || {};
    const rent = parseFloat(t.RentAmount || t.rent || unit.RentAmount || unit.rent || 0);
    const tenantPayments = payments.filter(p =>
      (p.TenantID || p.tenantId) === t.TenantID && (p.Period || p.period) === currentMonth
    );
    const paid = tenantPayments.reduce((sum, p) => sum + (parseFloat(p.Amount || p.amount) || 0), 0);
    const balance = rent - paid;

    return {
      tenant: t,
      unit,
      rent,
      paid,
      balance: balance > 0 ? balance : 0,
      status: balance > 0 ? 'Overdue' : 'Paid'
    };
  }).filter(a => a.balance > 0);

  res.render('arrears', { title: 'Arrears Report', user: req.session.user, arrears, currentMonth });
});

// ====== ROUTES: AUDIT LOG ======
app.get('/audit-log', requireAuth, requireRole(['Admin', 'Manager']), checkEnv, async (req, res) => {
  const logs = await getSheetData('AuditLog');
  const reversed = logs.reverse();
  res.render('audit-log', { title: 'Audit Log', user: req.session.user, logs: reversed });
});

// ====== API: MOBILE DATA ======
app.get('/api/summary', requireAuth, checkEnv, async (req, res) => {
  const [landlords, properties, units, tenants, payments, expenses] = await Promise.all([
    getSheetData('Landlords'), getSheetData('Properties'), getSheetData('Units'),
    getSheetData('Tenants'), getSheetData('Rent Collection'), getSheetData('Expenses')
  ]);

  res.json({
    landlords: landlords.length,
    properties: properties.length,
    units: { total: units.length, occupied: units.filter(u => u.Status === 'Occupied').length },
    tenants: tenants.filter(t => t.Status === 'Active').length,
    finance: {
      collected: payments.reduce((s, p) => s + (parseFloat(p.Amount || p.amount) || 0), 0),
      expenses: expenses.reduce((s, e) => s + (parseFloat(e.Amount || e.amount) || 0), 0)
    }
  });
});

// ====== ERROR HANDLING ======
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Error', user: req.session.user || null, message: err.message });
});

app.listen(PORT, () => {
  console.log(`PMS Server running on port ${PORT}`);
  console.log(`Google Sheets: ${googleAuthReady ? '✅ Connected' : '❌ Not connected - check env vars'}`);
});
