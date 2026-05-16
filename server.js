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

// ====== GOOGLE SHEETS SETUP ======
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

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

// ====== SHEETS HELPERS ======
async function getSheetData(sheetName) {
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
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
}

async function updateRow(sheetName, rowIndex, values) {
  const range = `${sheetName}!A${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
}

async function deleteRow(sheetName, rowIndex) {
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
}

async function getSheetId(sheetName) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
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

// ====== ROUTES: AUTH ======
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, title: 'Login' });
});

app.post('/login', async (req, res) => {
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

  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ====== ROUTES: DASHBOARD ======
app.get('/dashboard', requireAuth, async (req, res) => {
  const [landlords, properties, units, tenants, payments, expenses] = await Promise.all([
    getSheetData('Landlords'),
    getSheetData('Properties'),
    getSheetData('Units'),
    getSheetData('Tenants'),
    getSheetData('Payments'),
    getSheetData('Expenses')
  ]);

  const activeTenants = tenants.filter(t => t.Status === 'Active').length;
  const occupiedUnits = units.filter(u => u.Status === 'Occupied').length;
  const totalUnits = units.length;
  const monthlyRent = units.reduce((sum, u) => sum + (parseFloat(u.RentAmount) || 0), 0);
  const totalCollected = payments.reduce((sum, p) => sum + (parseFloat(p.Amount) || 0), 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + (parseFloat(e.Amount) || 0), 0);

  const recentPayments = payments
    .sort((a, b) => new Date(b['Created Date']) - new Date(a['Created Date']))
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
app.get('/landlords', requireAuth, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  res.render('landlords', { title: 'Landlords', user: req.session.user, landlords, error: null });
});

app.post('/landlords', requireAuth, async (req, res) => {
  const { fullName, email, phone, address, bankDetails, managementFee } = req.body;
  const id = 'LL' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Landlords', [id, fullName, email, phone, address, bankDetails, 'Active', now, managementFee || '10']);
  res.redirect('/landlords');
});

app.put('/landlords/:id', requireAuth, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  const landlord = landlords.find(l => l.LandlordID === req.params.id);
  if (!landlord) return res.status(404).send('Not found');

  const { fullName, email, phone, address, bankDetails, status, managementFee } = req.body;
  await updateRow('Landlords', landlord._rowIndex, [
    landlord.LandlordID, fullName, email, phone, address, bankDetails, status || 'Active', landlord['Created Date'], managementFee || landlord['Management Fee']
  ]);
  res.redirect('/landlords');
});

app.delete('/landlords/:id', requireAuth, async (req, res) => {
  const landlords = await getSheetData('Landlords');
  const landlord = landlords.find(l => l.LandlordID === req.params.id);
  if (landlord) await deleteRow('Landlords', landlord._rowIndex);
  res.redirect('/landlords');
});

// ====== ROUTES: PROPERTIES (CRUD) ======
app.get('/properties', requireAuth, async (req, res) => {
  const [properties, landlords] = await Promise.all([getSheetData('Properties'), getSheetData('Landlords')]);
  res.render('properties', { title: 'Properties', user: req.session.user, properties, landlords, error: null });
});

app.post('/properties', requireAuth, async (req, res) => {
  const { propertyName, address, landlordId, type } = req.body;
  const id = 'PR' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Properties', [id, propertyName, address, landlordId, type || 'Residential', 'Active', now]);
  res.redirect('/properties');
});

app.put('/properties/:id', requireAuth, async (req, res) => {
  const properties = await getSheetData('Properties');
  const prop = properties.find(p => p.PropertyID === req.params.id);
  if (!prop) return res.status(404).send('Not found');

  const { propertyName, address, landlordId, type, status } = req.body;
  await updateRow('Properties', prop._rowIndex, [
    prop.PropertyID, propertyName, address, landlordId, type || prop.Type, status || 'Active', prop['Created Date']
  ]);
  res.redirect('/properties');
});

app.delete('/properties/:id', requireAuth, async (req, res) => {
  const properties = await getSheetData('Properties');
  const prop = properties.find(p => p.PropertyID === req.params.id);
  if (prop) await deleteRow('Properties', prop._rowIndex);
  res.redirect('/properties');
});

// ====== ROUTES: UNITS (CRUD) ======
app.get('/units', requireAuth, async (req, res) => {
  const [units, properties] = await Promise.all([getSheetData('Units'), getSheetData('Properties')]);
  res.render('units', { title: 'Units', user: req.session.user, units, properties, error: null });
});

app.post('/units', requireAuth, async (req, res) => {
  const { propertyId, unitNumber, unitType, rentAmount } = req.body;
  const id = 'UN' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Units', [id, propertyId, unitNumber, unitType || 'Standard', rentAmount, 'Vacant', now]);
  res.redirect('/units');
});

app.put('/units/:id', requireAuth, async (req, res) => {
  const units = await getSheetData('Units');
  const unit = units.find(u => u.UnitID === req.params.id);
  if (!unit) return res.status(404).send('Not found');

  const { propertyId, unitNumber, unitType, rentAmount, status } = req.body;
  await updateRow('Units', unit._rowIndex, [
    unit.UnitID, propertyId, unitNumber, unitType || unit.UnitType, rentAmount, status || unit.Status, unit['Created Date']
  ]);
  res.redirect('/units');
});

app.delete('/units/:id', requireAuth, async (req, res) => {
  const units = await getSheetData('Units');
  const unit = units.find(u => u.UnitID === req.params.id);
  if (unit) await deleteRow('Units', unit._rowIndex);
  res.redirect('/units');
});

// ====== ROUTES: TENANTS (CRUD) ======
app.get('/tenants', requireAuth, async (req, res) => {
  const [tenants, units] = await Promise.all([getSheetData('Tenants'), getSheetData('Units')]);
  res.render('tenants', { title: 'Tenants', user: req.session.user, tenants, units, error: null });
});

app.post('/tenants', requireAuth, async (req, res) => {
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
  res.redirect('/tenants');
});

app.put('/tenants/:id', requireAuth, async (req, res) => {
  const tenants = await getSheetData('Tenants');
  const tenant = tenants.find(t => t.TenantID === req.params.id);
  if (!tenant) return res.status(404).send('Not found');

  const { fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit, status } = req.body;
  await updateRow('Tenants', tenant._rowIndex, [
    tenant.TenantID, fullName, email, phone, unitId, leaseStart, leaseEnd, rentAmount, deposit || tenant.Deposit, status || 'Active', tenant['Created Date']
  ]);
  res.redirect('/tenants');
});

app.delete('/tenants/:id', requireAuth, async (req, res) => {
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
  }
  res.redirect('/tenants');
});

// ====== ROUTES: PAYMENTS + RECEIPTS ======
app.get('/payments', requireAuth, async (req, res) => {
  const [payments, tenants, units] = await Promise.all([
    getSheetData('Payments'), getSheetData('Tenants'), getSheetData('Units')
  ]);
  res.render('payments', { title: 'Rent Payments', user: req.session.user, payments, tenants, units, error: null });
});

app.post('/payments', requireAuth, async (req, res) => {
  const { tenantId, amount, paymentDate, paymentMethod, period, notes } = req.body;
  const id = 'PM' + Date.now();
  const receiptNo = 'RCP-' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  const tenants = await getSheetData('Tenants');
  const tenant = tenants.find(t => t.TenantID === tenantId);
  const unitId = tenant ? tenant.UnitID : '';

  await appendRow('Payments', [id, tenantId, unitId, amount, paymentDate, paymentMethod, period, receiptNo, notes || '', now]);
  res.redirect('/payments');
});

// PDF RECEIPT GENERATOR
app.get('/receipt/:paymentId', requireAuth, async (req, res) => {
  const payments = await getSheetData('Payments');
  const payment = payments.find(p => p.PaymentID === req.params.paymentId);
  if (!payment) return res.status(404).send('Payment not found');

  const [tenants, units, properties] = await Promise.all([
    getSheetData('Tenants'), getSheetData('Units'), getSheetData('Properties')
  ]);

  const tenant = tenants.find(t => t.TenantID === payment.TenantID) || {};
  const unit = units.find(u => u.UnitID === payment.UnitID) || {};
  const property = properties.find(p => p.PropertyID === unit.PropertyID) || {};

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Receipt-${payment.ReceiptNo}.pdf"`);
  doc.pipe(res);

  doc.fontSize(24).fillColor('#1a237e').text('OFFICIAL RECEIPT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#666').text('Property Management System', { align: 'center' });
  doc.moveDown(1);

  doc.rect(50, doc.y, 500, 80).stroke('#1a237e');
  doc.fontSize(12).fillColor('#000').text(`Receipt No: ${payment.ReceiptNo}`, 70, doc.y + 15);
  doc.text(`Date: ${moment(payment.PaymentDate).format('MMMM Do YYYY')}`);
  doc.text(`Payment Method: ${payment.PaymentMethod || 'Cash'}`);
  doc.moveDown(2);

  doc.fontSize(14).fillColor('#1a237e').text('Received From:');
  doc.fontSize(12).fillColor('#000').text(tenant.FullName || 'N/A');
  doc.text(`Property: ${property.PropertyName || 'N/A'} - Unit ${unit.UnitNumber || 'N/A'}`);
  doc.moveDown(1);

  doc.rect(50, doc.y, 500, 60).fill('#f5f5f5').stroke('#ddd');
  doc.fillColor('#000').fontSize(16).text(`Amount Paid: $${parseFloat(payment.Amount).toFixed(2)}`, 70, doc.y - 45);
  doc.fontSize(11).text(`For Period: ${payment.Period || 'N/A'}`, 70, doc.y + 5);
  doc.moveDown(2);

  if (payment.Notes) {
    doc.fontSize(11).text(`Notes: ${payment.Notes}`);
    doc.moveDown(1);
  }

  doc.moveDown(2);
  doc.fontSize(10).fillColor('#666').text('Thank you for your payment!', { align: 'center' });
  doc.text(`Processed by: ${req.session.user.FullName} on ${moment().format('YYYY-MM-DD HH:mm')}`, { align: 'center' });

  doc.end();
});

// ====== ROUTES: EXPENSES ======
app.get('/expenses', requireAuth, async (req, res) => {
  const [expenses, properties] = await Promise.all([getSheetData('Expenses'), getSheetData('Properties')]);
  res.render('expenses', { title: 'Expenses', user: req.session.user, expenses, properties, error: null });
});

app.post('/expenses', requireAuth, async (req, res) => {
  const { propertyId, category, amount, date, description, receiptNo } = req.body;
  const id = 'EX' + Date.now();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  await appendRow('Expenses', [id, propertyId, category, amount, date, description, receiptNo || '', now]);
  res.redirect('/expenses');
});

app.delete('/expenses/:id', requireAuth, async (req, res) => {
  const expenses = await getSheetData('Expenses');
  const exp = expenses.find(e => e.ExpenseID === req.params.id);
  if (exp) await deleteRow('Expenses', exp._rowIndex);
  res.redirect('/expenses');
});

// ====== ROUTES: LANDLORD INVOICES (MANAGEMENT FEES) ======
app.get('/invoices', requireAuth, async (req, res) => {
  const [invoices, landlords, properties] = await Promise.all([
    getSheetData('Invoices'), getSheetData('Landlords'), getSheetData('Properties')
  ]);
  res.render('invoices', { title: 'Management Invoices', user: req.session.user, invoices, landlords, properties, error: null });
});

app.post('/invoices/generate', requireAuth, async (req, res) => {
  const { landlordId, period, propertyId } = req.body;
  const landlords = await getSheetData('Landlords');
  const properties = await getSheetData('Properties');
  const units = await getSheetData('Units');
  const payments = await getSheetData('Payments');

  const landlord = landlords.find(l => l.LandlordID === landlordId);
  if (!landlord) return res.redirect('/invoices');

  const landlordProps = properties.filter(p => p.LandlordID === landlordId);
  const propIds = landlordProps.map(p => p.PropertyID);
  const landlordUnits = units.filter(u => propIds.includes(u.PropertyID));
  const unitIds = landlordUnits.map(u => u.UnitID);

  const periodPayments = payments.filter(p => {
    return unitIds.includes(p.UnitID) && p.Period === period;
  });

  const totalCollected = periodPayments.reduce((sum, p) => sum + (parseFloat(p.Amount) || 0), 0);
  const feePercent = parseFloat(landlord['Management Fee']) || 10;
  const feeAmount = (totalCollected * feePercent / 100).toFixed(2);
  const netAmount = (totalCollected - feeAmount).toFixed(2);

  const id = 'INV' + Date.now();
  const invoiceNo = 'INV-' + moment().format('YYYYMM') + '-' + Math.floor(Math.random() * 1000);
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  await appendRow('Invoices', [id, landlordId, propertyId || '', period, feePercent, feeAmount, netAmount, 'Pending', now, invoiceNo, totalCollected]);
  res.redirect('/invoices');
});

// PDF INVOICE GENERATOR
app.get('/invoice/:invoiceId/pdf', requireAuth, async (req, res) => {
  const invoices = await getSheetData('Invoices');
  const invoice = invoices.find(i => i.InvoiceID === req.params.invoiceId);
  if (!invoice) return res.status(404).send('Invoice not found');

  const [landlords, properties, units, payments] = await Promise.all([
    getSheetData('Landlords'), getSheetData('Properties'), getSheetData('Units'), getSheetData('Payments')
  ]);

  const landlord = landlords.find(l => l.LandlordID === invoice.LandlordID) || {};
  const property = properties.find(p => p.PropertyID === invoice.PropertyID) || {};

  const landlordProps = properties.filter(p => p.LandlordID === invoice.LandlordID);
  const propIds = landlordProps.map(p => p.PropertyID);
  const landlordUnits = units.filter(u => propIds.includes(u.PropertyID));
  const unitIds = landlordUnits.map(u => u.UnitID);
  const periodPayments = payments.filter(p => unitIds.includes(p.UnitID) && p.Period === invoice.Period);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Invoice-${invoice.InvoiceNo}.pdf"`);
  doc.pipe(res);

  doc.fontSize(28).fillColor('#1a237e').text('MANAGEMENT FEE INVOICE', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#666').text('Property Management Services', { align: 'center' });
  doc.moveDown(1.5);

  doc.rect(50, doc.y, 500, 90).stroke('#1a237e');
  let y = doc.y + 15;
  doc.fontSize(11).fillColor('#000').text(`Invoice No: ${invoice.InvoiceNo}`, 70, y);
  doc.text(`Date: ${moment(invoice['Created Date']).format('MMMM Do YYYY')}`, 300, y);
  y += 20;
  doc.text(`Period: ${invoice.Period}`, 70, y);
  doc.text(`Status: ${invoice.Status}`, 300, y);
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
    doc.text(p.PaymentDate, 60, doc.y);
    doc.text(p.TenantID, 150, doc.y);
    doc.text(p.UnitID, 280, doc.y);
    doc.text(`$${parseFloat(p.Amount).toFixed(2)}`, 420, doc.y);
    total += parseFloat(p.Amount) || 0;
    doc.moveDown(0.5);
  });

  doc.moveDown(1);
  doc.rect(300, doc.y, 250, 80).stroke('#ddd');
  doc.fontSize(11).text(`Total Collected: $${total.toFixed(2)}`, 320, doc.y + 10);
  doc.text(`Management Fee (${invoice['Management Fee']}%): $${invoice['Fee Amount']}`, 320, doc.y + 5);
  doc.fontSize(14).fillColor('#1a237e').text(`NET PAYABLE: $${invoice['Net Amount']}`, 320, doc.y + 10);

  doc.moveDown(3);
  doc.fontSize(10).fillColor('#666').text('Please process payment within 30 days. Thank you for your business.', { align: 'center' });

  doc.end();
});

// ====== ROUTES: ARREARS ======
app.get('/arrears', requireAuth, async (req, res) => {
  const [tenants, units, payments] = await Promise.all([
    getSheetData('Tenants'), getSheetData('Units'), getSheetData('Payments')
  ]);

  const currentMonth = moment().format('YYYY-MM');
  const arrears = tenants.filter(t => t.Status === 'Active').map(t => {
    const unit = units.find(u => u.UnitID === t.UnitID) || {};
    const rent = parseFloat(t.RentAmount) || parseFloat(unit.RentAmount) || 0;
    const tenantPayments = payments.filter(p =>
      p.TenantID === t.TenantID && p.Period === currentMonth
    );
    const paid = tenantPayments.reduce((sum, p) => sum + (parseFloat(p.Amount) || 0), 0);
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

// ====== API: MOBILE DATA ======
app.get('/api/summary', requireAuth, async (req, res) => {
  const [landlords, properties, units, tenants, payments, expenses] = await Promise.all([
    getSheetData('Landlords'), getSheetData('Properties'), getSheetData('Units'),
    getSheetData('Tenants'), getSheetData('Payments'), getSheetData('Expenses')
  ]);

  res.json({
    landlords: landlords.length,
    properties: properties.length,
    units: { total: units.length, occupied: units.filter(u => u.Status === 'Occupied').length },
    tenants: tenants.filter(t => t.Status === 'Active').length,
    finance: {
      collected: payments.reduce((s, p) => s + (parseFloat(p.Amount) || 0), 0),
      expenses: expenses.reduce((s, e) => s + (parseFloat(e.Amount) || 0), 0)
    }
  });
});

// ====== ERROR HANDLING ======
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Error', user: req.session.user, message: err.message });
});

app.listen(PORT, () => console.log(`PMS Server running on port ${PORT}`));
