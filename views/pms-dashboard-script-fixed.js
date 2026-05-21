// ─────────────────────────────────────────────────────────────────────────────
// PMS DASHBOARD – FIXED SCRIPT
// Replace the entire <script>…</script> block in dashboard.html with this.
// ─────────────────────────────────────────────────────────────────────────────

const USER = <%- JSON.stringify(user) %>;
let landlords=[], properties=[], units=[], tenants=[], rentData=[],
    expenses=[], invoices=[], receipts=[], users=[], settings={};
let currentForm='', editingId=null;

// ── FIELD ACCESSORS ──────────────────────────────────────────────────────────
// These try multiple possible column-header spellings so the sheet doesn't
// have to match a single exact name.

const isActive = item => {
  const s = (item.Status || item.status || 'Active').trim().toLowerCase();
  return s === 'active' || s === '';
};
const isVacant = u => {
  const s = (u.Status || u.status || 'Vacant').trim().toLowerCase();
  return s === 'vacant' || s === '';
};

// Landlord
const ll = {
  id:   l => l.ID || l.LandlordID || l['Landlord ID'] || '',
  name: l => l.Name || l['Full Name'] || l.LandlordName || '',
  phone:l => l.Phone || l['Phone Number'] || l.Mobile || '',
  email:l => l.Email || l['Email Address'] || '',
  addr: l => l.Address || '',
  bank: l => l['Bank Name'] || l.BankName || l.Bank || '',
  acct: l => l['Bank Account'] || l.BankAccount || l.Account || '',
  comm: l => l['Commission Rate'] || l.CommissionRate || l.Commission || '10',
  status:l=> l.Status || l.status || 'Active',
};

// Property
const pr = {
  id:   p => p.ID || p.PropertyID || p['Property ID'] || '',
  name: p => p.Name || p.PropertyName || p['Property Name'] || '',
  llid: p => p['Landlord ID'] || p.LandlordID || p.LandlordId || '',
  addr: p => p.Address || '',
  type: p => p.Type || 'Residential',
  units:p => p['Total Units'] || p.TotalUnits || '0',
  status:p=> p.Status || p.status || 'Active',
};

// Unit
const un = {
  id:   u => u.ID || u.UnitID || u['Unit ID'] || '',
  prop: u => u['Property ID'] || u.PropertyID || u.PropertyId || '',
  num:  u => u['Unit Number'] || u.UnitNumber || u.Unit || u.UnitNo || '',
  type: u => u.Type || u.UnitType || 'Studio',
  rent: u => u.Rent || u['Rent Amount'] || u.RentAmount || '0',
  desc: u => u.Description || u.Notes || '',
  status:u=> u.Status || u.status || 'Vacant',
};

// Tenant
const tn = {
  id:     t => t.ID || t.TenantID || t['Tenant ID'] || '',
  name:   t => t.Name || t['Full Name'] || t.TenantName || '',
  phone:  t => t.Phone || t['Phone Number'] || t.Mobile || '',
  email:  t => t.Email || t['Email Address'] || '',
  idno:   t => t['ID Number'] || t.IDNumber || t.idNumber || t['National ID'] || t['Passport'] || '',
  unit:   t => t['Unit ID'] || t.UnitID || t.UnitId || '',
  start:  t => t['Lease Start'] || t.LeaseStart || '',
  end:    t => t['Lease End'] || t.LeaseEnd || '',
  rent:   t => t['Rent Amount'] || t.RentAmount || t.Rent || '0',
  deposit:t => t.Deposit || t['Security Deposit'] || '0',
  status: t => t.Status || t.status || 'Active',
};

// Rent record
const rn = {
  id:     r => r.ID || r.RentID || r['Rent ID'] || '',
  tenant: r => r['Tenant ID'] || r.TenantID || r.TenantId || '',
  unit:   r => r['Unit ID'] || r.UnitID || r.UnitId || '',
  amount: r => r.Amount || '0',
  month:  r => r.Month || '',
  year:   r => r.Year || '',
  method: r => r['Payment Method'] || r.PaymentMethod || 'Cash',
  ref:    r => r.Reference || r.Ref || '',
  date:   r => r.Date || '',
};

// Expense
const ex = {
  id:   e => e.ID || e.ExpenseID || '',
  prop: e => e['Property ID'] || e.PropertyID || e.PropertyId || '',
  cat:  e => e.Category || 'Other',
  desc: e => e.Description || '',
  amt:  e => e.Amount || '0',
  date: e => e.Date || '',
};

// Invoice
const inv = {
  id:     i => i.ID || i.InvoiceID || '',
  type:   i => i.Type || '',
  eid:    i => i.EntityId || i['Entity ID'] || i.EntityID || '',
  ename:  i => i.EntityName || i['Entity Name'] || '',
  desc:   i => i.Description || '',
  amt:    i => i.Amount || '0',
  month:  i => i.Month || '',
  year:   i => i.Year || '',
  status: i => i.Status || 'Unpaid',
  date:   i => i.Date || '',
};

// Receipt
const rc = {
  id:     r => r.ID || r.ReceiptID || '',
  tenant: r => r.TenantName || r['Tenant Name'] || '',
  unit:   r => r.UnitNumber || r['Unit Number'] || '',
  amt:    r => r.Amount || '0',
  month:  r => r.Month || '',
  year:   r => r.Year || '',
  method: r => r.PaymentMethod || r['Payment Method'] || 'Cash',
  date:   r => r.Date || '',
};

// User
const ur = {
  id:     u => u.ID || u.UserID || u['User ID'] || '',
  name:   u => u.Name || u['Full Name'] || u.FullName || '',
  uname:  u => u.Username || u.username || u['User Name'] || u.sernam || '',
  email:  u => u.Email || u['Email Address'] || '',
  role:   u => u.Role || u.role || 'User',
  status: u => u.Status || u.status || 'Active',
};

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('userName').textContent = USER.name || USER.username;
  document.getElementById('userRole').textContent = USER.role;
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString(
    'en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'}
  );
  if (USER.role !== 'Admin') {
    ['navAdminLabel','navUsers','navSettings'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  loadAllData();
});

function logout() { window.location.href = '/logout'; }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('sec-' + id).classList.add('active');
  if (event && event.target) event.target.classList.add('active');
  document.getElementById('pageTitle').textContent = id.charAt(0).toUpperCase() + id.slice(1);
  document.getElementById('sidebar').classList.remove('open');
  if (id === 'arrears') loadArrears();
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────
async function loadAllData() {
  try {
    const stats = await fetch('/api/stats').then(r => r.json());
    document.getElementById('statLandlords').textContent  = stats.landlords    || 0;
    document.getElementById('statProperties').textContent = stats.properties   || 0;
    document.getElementById('statUnits').textContent      = stats.units        || 0;
    document.getElementById('statTenants').textContent    = stats.tenants      || 0;
    document.getElementById('statOccupied').textContent   = stats.occupied     || 0;
    document.getElementById('statVacant').textContent     = stats.vacant       || 0;
    document.getElementById('statRent').textContent       = (stats.totalRent      || 0).toLocaleString();
    document.getElementById('statExpenses').textContent   = (stats.totalExpenses  || 0).toLocaleString();
  } catch(e) { console.error('Stats error', e); }

  const load = async (url, fallback=[]) => {
    try { return await fetch(url).then(r => r.json()); }
    catch(e) { console.error('Load error ' + url, e); return fallback; }
  };

  landlords  = await load('/api/landlords');  renderLandlords();
  properties = await load('/api/properties'); renderProperties();
  units      = await load('/api/units');      renderUnits();
  tenants    = await load('/api/tenants');    renderTenants();
  rentData   = await load('/api/rent');       renderRent();
  expenses   = await load('/api/expenses');   renderExpenses();
  invoices   = await load('/api/invoices');   renderInvoices();
  receipts   = await load('/api/receipts');   renderReceipts();
  users      = await load('/api/users');      renderUsers();
  settings   = await load('/api/settings', {}); renderSettings();

  console.log('Loaded → LL:', landlords.length, 'PR:', properties.length,
    'UN:', units.length, 'TN:', tenants.length, 'RN:', rentData.length);
}

// ── RENDER FUNCTIONS ──────────────────────────────────────────────────────────
function renderLandlords() {
  const tbody = document.getElementById('landlordsTable');
  if (!landlords.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">📋</div><h3>No landlords yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = landlords.map(l => `
    <tr>
      <td>${ll.id(l)}</td>
      <td>${ll.name(l)}</td>
      <td>${ll.phone(l)}</td>
      <td>${ll.email(l)}</td>
      <td>${ll.comm(l)}%</td>
      <td><span class="badge ${isActive(l) ? 'success' : 'danger'}">${ll.status(l)}</span></td>
      <td class="actions">
        <button class="btn-edit"   onclick="editLandlord('${ll.id(l)}')">Edit</button>
        <button class="btn-delete" onclick="deleteLandlord('${ll.id(l)}')">Delete</button>
      </td>
    </tr>`).join('');
}

function renderProperties() {
  const tbody = document.getElementById('propertiesTable');
  if (!properties.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">🏘️</div><h3>No properties yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = properties.map(p => {
    const l = landlords.find(x => ll.id(x) === pr.llid(p)) || {};
    return `
    <tr>
      <td>${pr.id(p)}</td>
      <td>${pr.name(p)}</td>
      <td>${ll.name(l) || pr.llid(p)}</td>
      <td>${pr.addr(p)}</td>
      <td>${pr.type(p)}</td>
      <td>${pr.units(p)}</td>
      <td><span class="badge ${isActive(p) ? 'success' : 'danger'}">${pr.status(p)}</span></td>
      <td class="actions">
        <button class="btn-edit" onclick="editProperty('${pr.id(p)}')">Edit</button>
      </td>
    </tr>`;
  }).join('');
}

function renderUnits() {
  const tbody = document.getElementById('unitsTable');
  if (!units.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">🚪</div><h3>No units yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = units.map(u => {
    const p = properties.find(x => pr.id(x) === un.prop(u)) || {};
    const statusBadge = isVacant(u) ? 'warning' : 'success';
    return `
    <tr>
      <td>${un.id(u)}</td>
      <td>${pr.name(p) || un.prop(u)}</td>
      <td>${un.num(u)}</td>
      <td>${un.type(u)}</td>
      <td>${un.rent(u)}</td>
      <td><span class="badge ${statusBadge}">${un.status(u)}</span></td>
      <td class="actions">
        <button class="btn-edit" onclick="editUnit('${un.id(u)}')">Edit</button>
      </td>
    </tr>`;
  }).join('');
}

function renderTenants() {
  const tbody = document.getElementById('tenantsTable');
  if (!tenants.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">👥</div><h3>No tenants yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = tenants.map(t => {
    const u = units.find(x => un.id(x) === tn.unit(t)) || {};
    return `
    <tr>
      <td>${tn.id(t)}</td>
      <td>${tn.name(t)}</td>
      <td>${tn.phone(t)}</td>
      <td>${un.num(u) || tn.unit(t)}</td>
      <td>${tn.rent(t)}</td>
      <td>${tn.end(t)}</td>
      <td><span class="badge ${isActive(t) ? 'success' : 'danger'}">${tn.status(t)}</span></td>
      <td class="actions">
        <button class="btn-edit" onclick="editTenant('${tn.id(t)}')">Edit</button>
      </td>
    </tr>`;
  }).join('');
}

function renderRent() {
  const tbody = document.getElementById('rentTable');
  if (!rentData.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">💰</div><h3>No payments recorded</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = rentData.map(r => {
    const t = tenants.find(x => tn.id(x) === rn.tenant(r)) || {};
    const u = units.find(x => un.id(x) === rn.unit(r)) || {};
    return `
    <tr>
      <td>${rn.id(r)}</td>
      <td>${tn.name(t) || rn.tenant(r)}</td>
      <td>${un.num(u) || rn.unit(r)}</td>
      <td>${rn.amount(r)}</td>
      <td>${rn.month(r)} ${rn.year(r)}</td>
      <td>${rn.method(r)}</td>
      <td>${rn.date(r)}</td>
      <td class="actions">
        <button class="btn-receipt" onclick="quickReceiptFromRent('${rn.id(r)}')">🧾 Receipt</button>
      </td>
    </tr>`;
  }).join('');
}

function renderExpenses() {
  const tbody = document.getElementById('expensesTable');
  if (!expenses.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="icon">📑</div><h3>No expenses recorded</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = expenses.map(e => {
    const p = properties.find(x => pr.id(x) === ex.prop(e)) || {};
    return `
    <tr>
      <td>${ex.id(e)}</td>
      <td>${pr.name(p) || ex.prop(e) || '—'}</td>
      <td>${ex.cat(e)}</td>
      <td>${ex.desc(e)}</td>
      <td>${ex.amt(e)}</td>
      <td>${ex.date(e)}</td>
      <td class="actions">
        <button class="btn-edit" onclick="editExpense('${ex.id(e)}')">Edit</button>
      </td>
    </tr>`;
  }).join('');
}

function renderInvoices() {
  const tbody = document.getElementById('invoicesTable');
  if (!invoices.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">📄</div><h3>No invoices yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = invoices.map(i => `
    <tr>
      <td>${inv.id(i)}</td>
      <td>${inv.type(i)}</td>
      <td>${inv.ename(i)}</td>
      <td>${inv.desc(i)}</td>
      <td>${inv.amt(i)}</td>
      <td>${inv.month(i)} ${inv.year(i)}</td>
      <td><span class="badge ${inv.status(i).toLowerCase() === 'paid' ? 'success' : 'danger'}">${inv.status(i)}</span></td>
      <td class="actions">
        <button class="btn-view" onclick="viewInvoice('${inv.id(i)}')">View</button>
        ${inv.status(i) !== 'Paid'
          ? `<button class="btn-edit" onclick="payInvoice('${inv.id(i)}')">Pay</button>`
          : ''}
      </td>
    </tr>`).join('');
}

function renderReceipts() {
  const tbody = document.getElementById('receiptsTable');
  if (!receipts.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">🧾</div><h3>No receipts yet</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = receipts.map(r => `
    <tr>
      <td>${rc.id(r)}</td>
      <td>${rc.tenant(r)}</td>
      <td>${rc.unit(r)}</td>
      <td>${rc.amt(r)}</td>
      <td>${rc.month(r)} ${rc.year(r)}</td>
      <td>${rc.method(r)}</td>
      <td>${rc.date(r)}</td>
      <td class="actions">
        <button class="btn-view" onclick="viewReceipt('${rc.id(r)}')">View</button>
      </td>
    </tr>`).join('');
}

function renderUsers() {
  const tbody = document.getElementById('usersTable');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">🔐</div><h3>No users found</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${ur.id(u)}</td>
      <td>${ur.name(u)}</td>
      <td>${ur.uname(u)}</td>
      <td>${ur.email(u)}</td>
      <td><span class="badge info">${ur.role(u)}</span></td>
      <td><span class="badge ${isActive(u) ? 'success' : 'danger'}">${ur.status(u)}</span></td>
    </tr>`).join('');
}

function renderSettings() {
  const div = document.getElementById('settingsContent');
  const entries = Object.entries(settings);
  if (!entries.length) { div.innerHTML = '<p>No settings configured</p>'; return; }
  div.innerHTML = entries.map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);">
      <strong>${k}</strong><span>${v}</span>
    </div>`).join('');
}

// ── ARREARS ───────────────────────────────────────────────────────────────────
function loadArrears() {
  const tbody = document.getElementById('arrearsTable');
  const activeTenants = tenants.filter(t => isActive(t));
  const arrears = [];
  const now = new Date();

  activeTenants.forEach(t => {
    const u = units.find(x => un.id(x) === tn.unit(t));
    const rentAmt = parseFloat(tn.rent(t)) || 0;
    if (!rentAmt) return;
    const leaseStart = tn.start(t) ? new Date(tn.start(t)) : null;
    if (!leaseStart) return;
    const tenantPayments = rentData.filter(r => rn.tenant(r) === tn.id(t));
    const paidMonths = new Set(tenantPayments.map(r => `${rn.year(r)}-${rn.month(r)}`));
    let monthsDue = 0;
    let check = new Date(leaseStart);
    check.setMonth(check.getMonth() + 1);
    while (check <= now) {
      const ym = `${check.getFullYear()}-${String(check.getMonth() + 1).padStart(2, '0')}`;
      if (!paidMonths.has(ym)) monthsDue++;
      check.setMonth(check.getMonth() + 1);
    }
    if (monthsDue > 0)
      arrears.push({ t, u, rent: rentAmt, months: monthsDue, total: rentAmt * monthsDue });
  });

  if (!arrears.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="icon">✅</div><h3>No arrears — all tenants up to date</h3></div></td></tr>';
    return;
  }
  tbody.innerHTML = arrears.map(a => `
    <tr>
      <td>${tn.name(a.t)}</td>
      <td>${a.u ? un.num(a.u) : 'N/A'}</td>
      <td>${a.rent.toLocaleString()}</td>
      <td>${a.months}</td>
      <td style="color:var(--danger);font-weight:700">${a.total.toLocaleString()}</td>
      <td class="actions">
        <button class="btn-edit" onclick="openModal('rent','${tn.id(a.t)}')">Record Payment</button>
      </td>
    </tr>`).join('');
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(type, prefillTenantId = null) {
  currentForm = type;
  editingId   = null;
  document.getElementById('modalOverlay').classList.add('active');
  const body  = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');

  // Build option lists
  const llOpts = landlords.filter(isActive)
    .map(l => `<option value="${ll.id(l)}">${ll.name(l)}</option>`).join('');
  const propOpts = properties.filter(isActive)
    .map(p => `<option value="${pr.id(p)}">${pr.name(p)}</option>`).join('');
  const vacantUnitOpts = units.filter(isVacant)
    .map(u => {
      const p = properties.find(x => pr.id(x) === un.prop(u)) || {};
      return `<option value="${un.id(u)}" data-rent="${un.rent(u)}">${un.num(u)} – ${pr.name(p) || un.prop(u)}</option>`;
    }).join('');
  const tenantOpts = tenants.filter(isActive)
    .map(t => `<option value="${tn.id(t)}" data-unit="${tn.unit(t)}" data-rent="${tn.rent(t)}">${tn.name(t)}</option>`).join('');

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const curMonth = new Date().getMonth();
  const monthOpts = months.map((m, i) =>
    `<option value="${String(i+1).padStart(2,'0')}" ${i === curMonth ? 'selected' : ''}>${m}</option>`
  ).join('');
  const curYear = new Date().getFullYear();
  const today = new Date().toISOString().split('T')[0];

  const EXPENSE_CATS = [
    'Maintenance','Utilities','Insurance','Property Tax','Legal Fees','Marketing',
    'Cleaning','Security','Repairs','Renovation','Landscaping','Management Fees',
    'Commission','Other'
  ];
  const catOpts = EXPENSE_CATS.map(c => `<option>${c}</option>`).join('');

  const FORMS = {

    landlord: () => {
      title.textContent = 'Add Landlord';
      return `<div class="form-grid">
        <div class="form-group full"><label>Full Name *</label><input id="f_name" required placeholder="e.g. John Mukasa"></div>
        <div class="form-group"><label>Phone</label><input id="f_phone" placeholder="+256 7XX XXX XXX"></div>
        <div class="form-group"><label>Email</label><input id="f_email" type="email"></div>
        <div class="form-group full"><label>Address</label><input id="f_address"></div>
        <div class="form-group"><label>Bank Name</label><input id="f_bank" placeholder="e.g. Stanbic Bank"></div>
        <div class="form-group"><label>Bank Account No.</label><input id="f_account"></div>
        <div class="form-group"><label>Commission Rate (%)</label><input id="f_commission" type="number" value="10" min="0" max="100"></div>
      </div>`;
    },

    property: () => {
      title.textContent = 'Add Property';
      return `<div class="form-grid">
        <div class="form-group full"><label>Property Name *</label><input id="f_name" required placeholder="e.g. Bugolobi Apartments"></div>
        <div class="form-group full"><label>Landlord *</label>
          <select id="f_landlord" required>
            <option value="">— Select landlord —</option>
            ${llOpts || '<option disabled>No landlords found — add one first</option>'}
          </select>
        </div>
        <div class="form-group full"><label>Address / Location</label><input id="f_address" placeholder="e.g. Plot 12, Nakasero Road"></div>
        <div class="form-group"><label>Property Type</label>
          <select id="f_type">
            <option>Residential</option><option>Commercial</option>
            <option>Mixed</option><option>Industrial</option>
          </select>
        </div>
      </div>`;
    },

    unit: () => {
      title.textContent = 'Add Unit';
      return `<div class="form-grid">
        <div class="form-group full"><label>Property *</label>
          <select id="f_property" required>
            <option value="">— Select property —</option>
            ${propOpts || '<option disabled>No properties found — add one first</option>'}
          </select>
        </div>
        <div class="form-group"><label>Unit Number / Name *</label>
          <input id="f_unitno" required placeholder="e.g. A1, Unit 3, Shop 2"></div>
        <div class="form-group"><label>Unit Type</label>
          <select id="f_type">
            <option>Studio</option><option>1 Bedroom</option><option>2 Bedroom</option>
            <option>3 Bedroom</option><option>4+ Bedroom</option>
            <option>Shop</option><option>Office</option><option>Warehouse</option>
          </select>
        </div>
        <div class="form-group"><label>Monthly Rent (UGX)</label>
          <input id="f_rent" type="number" placeholder="0" min="0"></div>
        <div class="form-group full"><label>Description / Notes</label>
          <textarea id="f_desc" placeholder="Floor level, features, parking, etc."></textarea>
        </div>
      </div>`;
    },

    tenant: () => {
      title.textContent = 'Add Tenant';
      return `<div class="form-grid">
        <div class="form-group full"><label>Full Name *</label>
          <input id="f_name" required placeholder="e.g. Mary Namukasa"></div>
        <div class="form-group"><label>Phone *</label>
          <input id="f_phone" required placeholder="+256 7XX XXX XXX"></div>
        <div class="form-group"><label>Email</label>
          <input id="f_email" type="email"></div>
        <div class="form-group"><label>National ID / Passport</label>
          <input id="f_idno" placeholder="ID number"></div>
        <div class="form-group full"><label>Vacant Unit *</label>
          <select id="f_unit" required>
            <option value="">— Select unit —</option>
            ${vacantUnitOpts || '<option disabled>No vacant units available</option>'}
          </select>
        </div>
        <div class="form-group"><label>Lease Start</label>
          <input id="f_start" type="date" value="${today}"></div>
        <div class="form-group"><label>Lease End</label>
          <input id="f_end" type="date"></div>
        <div class="form-group"><label>Monthly Rent (UGX)</label>
          <input id="f_rent" type="number" placeholder="Auto-fills from unit" min="0"></div>
        <div class="form-group"><label>Security Deposit (UGX)</label>
          <input id="f_deposit" type="number" placeholder="0" min="0"></div>
      </div>`;
    },

    rent: () => {
      title.textContent = 'Record Rent Payment';
      return `<div class="form-grid">
        <div class="form-group full"><label>Tenant *</label>
          <select id="f_tenant" required onchange="autoFillUnit()">
            <option value="">— Select tenant —</option>
            ${tenantOpts || '<option disabled>No active tenants found</option>'}
          </select>
        </div>
        <div class="form-group"><label>Unit (auto-filled)</label>
          <input id="f_unit" readonly style="background:#f8fafc;cursor:not-allowed"></div>
        <div class="form-group"><label>Amount (UGX) *</label>
          <input id="f_amount" type="number" required placeholder="0" min="0"></div>
        <div class="form-group"><label>Month</label>
          <select id="f_month">${monthOpts}</select></div>
        <div class="form-group"><label>Year</label>
          <input id="f_year" type="number" value="${curYear}" min="2000" max="2100"></div>
        <div class="form-group"><label>Payment Method</label>
          <select id="f_method">
            <option>Cash</option><option>Bank Transfer</option>
            <option>Mobile Money</option><option>Cheque</option><option>Card</option>
          </select>
        </div>
        <div class="form-group full"><label>Reference / Transaction ID</label>
          <input id="f_ref" placeholder="Cheque no., Mobile Money ref., etc."></div>
      </div>`;
    },

    expense: () => {
      title.textContent = 'Add Expense';
      return `<div class="form-grid">
        <div class="form-group full"><label>Property (optional)</label>
          <select id="f_property">
            <option value="">— General / Not property-specific —</option>
            ${propOpts}
          </select>
        </div>
        <div class="form-group"><label>Category *</label>
          <select id="f_category" required>${catOpts}</select></div>
        <div class="form-group full"><label>Description *</label>
          <input id="f_desc" required placeholder="What was this expense for?"></div>
        <div class="form-group"><label>Amount (UGX) *</label>
          <input id="f_amount" type="number" required placeholder="0" min="0"></div>
        <div class="form-group"><label>Date</label>
          <input id="f_date" type="date" value="${today}"></div>
      </div>`;
    },

    invoice: () => {
      title.textContent = 'Create Invoice';
      return `<div class="form-grid">
        <div class="form-group full"><label>Invoice Type *</label>
          <select id="f_invType" required onchange="updateInvoiceEntity()">
            <option value="">— Select type —</option>
            <option value="landlord">Landlord Management Fee</option>
            <option value="tenant">Tenant Rent Invoice</option>
          </select>
        </div>
        <div class="form-group full"><label>Bill To *</label>
          <select id="f_entity" required disabled>
            <option value="">Select type first…</option>
          </select>
        </div>
        <div class="form-group full"><label>Description</label>
          <input id="f_desc" placeholder="e.g. Management fee for June 2025"></div>
        <div class="form-group"><label>Amount (UGX) *</label>
          <input id="f_amount" type="number" required placeholder="0" min="0"></div>
        <div class="form-group"><label>Month</label>
          <select id="f_month">${monthOpts}</select></div>
        <div class="form-group"><label>Year</label>
          <input id="f_year" type="number" value="${curYear}"></div>
      </div>`;
    }
  };

  body.innerHTML = (FORMS[type] ? FORMS[type]() : '<p>Unknown form type</p>');

  // Auto-attach unit-rent fill for tenant form
  if (type === 'tenant') {
    const unitSel = document.getElementById('f_unit');
    if (unitSel) unitSel.addEventListener('change', () => {
      const opt = unitSel.selectedOptions[0];
      const rentField = document.getElementById('f_rent');
      if (opt && opt.dataset.rent && rentField && !rentField.value)
        rentField.value = opt.dataset.rent;
    });
  }

  // Pre-fill tenant for rent modal (called from Arrears)
  if (type === 'rent' && prefillTenantId) {
    const t = tenants.find(x => tn.id(x) === prefillTenantId);
    if (t) {
      setTimeout(() => {
        const sel = document.getElementById('f_tenant');
        const unitInput = document.getElementById('f_amount');
        if (sel) sel.value = tn.id(t);
        autoFillUnit();
      }, 50);
    }
  }
}

function autoFillUnit() {
  const sel = document.getElementById('f_tenant');
  if (!sel || !sel.value) return;
  const opt = sel.selectedOptions[0];
  const unitId = opt?.dataset?.unit || '';
  const unitInput = document.getElementById('f_unit');
  const amtInput  = document.getElementById('f_amount');
  if (unitInput) unitInput.value = unitId;
  if (amtInput && !amtInput.value && opt?.dataset?.rent)
    amtInput.value = opt.dataset.rent;
}

function updateInvoiceEntity() {
  const typeSel   = document.getElementById('f_invType');
  const entitySel = document.getElementById('f_entity');
  if (!typeSel || !entitySel) return;
  entitySel.disabled = false;
  if (typeSel.value === 'landlord') {
    entitySel.innerHTML = '<option value="">— Select landlord —</option>' +
      landlords.filter(isActive).map(l =>
        `<option value="${ll.id(l)}">${ll.name(l)}</option>`).join('');
  } else if (typeSel.value === 'tenant') {
    entitySel.innerHTML = '<option value="">— Select tenant —</option>' +
      tenants.filter(isActive).map(t =>
        `<option value="${tn.id(t)}">${tn.name(t)}</option>`).join('');
  } else {
    entitySel.disabled = true;
    entitySel.innerHTML = '<option value="">Select type first…</option>';
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
  const saveBtn = document.getElementById('modalSave');
  saveBtn.onclick = null;
  saveBtn.textContent = 'Save';
  saveBtn.disabled = false;
  currentForm = '';
  editingId   = null;
}

// ── SAVE FORM ─────────────────────────────────────────────────────────────────
async function saveForm() {
  const btn = document.getElementById('modalSave');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  try {
    let payload = {}, endpoint = '', method = 'POST';
    const gv = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

    switch (currentForm) {

      case 'landlord':
        if (!gv('f_name')) { showToast('Name is required', 'error'); break; }
        endpoint = editingId ? '/api/landlords/' + editingId : '/api/landlords';
        method   = editingId ? 'PUT' : 'POST';
        payload  = { name:gv('f_name'), phone:gv('f_phone'), email:gv('f_email'),
                     address:gv('f_address'), bankName:gv('f_bank'),
                     bankAccount:gv('f_account'), commissionRate:gv('f_commission') };
        break;

      case 'property':
        if (!gv('f_name'))     { showToast('Property name is required', 'error'); break; }
        if (!gv('f_landlord')) { showToast('Please select a landlord', 'error'); break; }
        endpoint = editingId ? '/api/properties/' + editingId : '/api/properties';
        method   = editingId ? 'PUT' : 'POST';
        payload  = { name:gv('f_name'), landlordId:gv('f_landlord'),
                     address:gv('f_address'), type:gv('f_type') };
        break;

      case 'unit':
        if (!gv('f_property')) { showToast('Please select a property', 'error'); break; }
        if (!gv('f_unitno'))   { showToast('Unit number is required', 'error'); break; }
        endpoint = editingId ? '/api/units/' + editingId : '/api/units';
        method   = editingId ? 'PUT' : 'POST';
        payload  = { propertyId:gv('f_property'), unitNumber:gv('f_unitno'),
                     type:gv('f_type'), rent:gv('f_rent'), description:gv('f_desc') };
        break;

      case 'tenant':
        if (!gv('f_name'))  { showToast('Tenant name is required', 'error'); break; }
        if (!gv('f_phone')) { showToast('Phone number is required', 'error'); break; }
        if (!gv('f_unit'))  { showToast('Please select a unit', 'error'); break; }
        endpoint = editingId ? '/api/tenants/' + editingId : '/api/tenants';
        method   = editingId ? 'PUT' : 'POST';
        payload  = { name:gv('f_name'), phone:gv('f_phone'), email:gv('f_email'),
                     idNumber:gv('f_idno'), unitId:gv('f_unit'), leaseStart:gv('f_start'),
                     leaseEnd:gv('f_end'), rentAmount:gv('f_rent'), deposit:gv('f_deposit') };
        break;

      case 'rent':
        if (!gv('f_tenant')) { showToast('Please select a tenant', 'error'); break; }
        if (!gv('f_amount')) { showToast('Amount is required', 'error'); break; }
        endpoint = '/api/rent';
        payload  = { tenantId:gv('f_tenant'), unitId:gv('f_unit'), amount:gv('f_amount'),
                     month:gv('f_month'), year:gv('f_year'),
                     paymentMethod:gv('f_method'), reference:gv('f_ref') };
        break;

      case 'expense':
        if (!gv('f_desc'))   { showToast('Description is required', 'error'); break; }
        if (!gv('f_amount')) { showToast('Amount is required', 'error'); break; }
        endpoint = editingId ? '/api/expenses/' + editingId : '/api/expenses';
        method   = editingId ? 'PUT' : 'POST';
        payload  = { propertyId:gv('f_property'), category:gv('f_category'),
                     description:gv('f_desc'), amount:gv('f_amount'), date:gv('f_date') };
        break;

      case 'invoice':
        if (!gv('f_invType') || !gv('f_entity')) {
          showToast('Select invoice type and who to bill', 'error'); break; }
        if (!gv('f_amount')) { showToast('Amount is required', 'error'); break; }
        endpoint = '/api/invoices';
        payload  = { type:gv('f_invType'), entityId:gv('f_entity'),
                     entityName:getEntityName(gv('f_invType'), gv('f_entity')),
                     description:gv('f_desc'), amount:gv('f_amount'),
                     month:gv('f_month'), year:gv('f_year') };
        break;

      default:
        showToast('Unknown form', 'error');
        btn.textContent = 'Save'; btn.disabled = false;
        return;
    }

    if (!endpoint) { btn.textContent = 'Save'; btn.disabled = false; return; }

    const res  = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      const savedForm    = currentForm;
      const savedId      = data.id;
      const savedPayload = { ...payload };

      showToast('Saved successfully!', 'success');
      closeModal();
      await loadAllData();

      // After adding a property → prompt to add units
      if (savedForm === 'property' && !editingId) {
        showPrompt(
          'Add Units Now?',
          `"${savedPayload.name}" added. Do you want to add units to this property now?`,
          () => {
            openModal('unit');
            setTimeout(() => {
              const sel = document.getElementById('f_property');
              if (sel) sel.value = savedId;
            }, 80);
          }
        );
      }

      // After recording rent → auto-generate receipt and prompt to view
      if (savedForm === 'rent') {
        const t = tenants.find(x => tn.id(x) === savedPayload.tenantId) || {};
        const u = units.find(x => un.id(x) === savedPayload.unitId)     || {};
        const rcpPayload = {
          rentId: savedId,
          tenantName: tn.name(t),
          unitNumber: un.num(u),
          amount: savedPayload.amount,
          month: savedPayload.month,
          year: savedPayload.year,
          paymentMethod: savedPayload.paymentMethod
        };
        const rcpRes  = await fetch('/api/receipts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rcpPayload)
        });
        const rcpData = await rcpRes.json();
        if (rcpData.success) {
          await loadAllData();
          showToast('Receipt generated!', 'success');
          showPrompt('View Receipt?', 'Receipt generated. Open it now?',
            () => viewReceipt(rcpData.id));
        }
      }

    } else {
      showToast(data.error || 'Failed to save', 'error');
    }

  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }

  btn.textContent = 'Save';
  btn.disabled = false;
}

function getEntityName(type, id) {
  if (type === 'landlord') { const l = landlords.find(x => ll.id(x) === id); return l ? ll.name(l) : ''; }
  else                     { const t = tenants.find(x => tn.id(x) === id);   return t ? tn.name(t) : ''; }
}

// ── EDIT FUNCTIONS ────────────────────────────────────────────────────────────
function editLandlord(id) {
  const l = landlords.find(x => ll.id(x) === id);
  if (!l) { showToast('Landlord not found', 'error'); return; }
  openModal('landlord');
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Landlord';
  setTimeout(() => {
    document.getElementById('f_name').value       = ll.name(l);
    document.getElementById('f_phone').value      = ll.phone(l);
    document.getElementById('f_email').value      = ll.email(l);
    document.getElementById('f_address').value    = ll.addr(l);
    document.getElementById('f_bank').value       = ll.bank(l);
    document.getElementById('f_account').value    = ll.acct(l);
    document.getElementById('f_commission').value = ll.comm(l);
  }, 60);
}

function editProperty(id) {
  const p = properties.find(x => pr.id(x) === id);
  if (!p) { showToast('Property not found', 'error'); return; }
  openModal('property');
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Property';
  setTimeout(() => {
    document.getElementById('f_name').value     = pr.name(p);
    document.getElementById('f_landlord').value = pr.llid(p);
    document.getElementById('f_address').value  = pr.addr(p);
    document.getElementById('f_type').value     = pr.type(p);
  }, 60);
}

function editUnit(id) {
  const u = units.find(x => un.id(x) === id);
  if (!u) { showToast('Unit not found', 'error'); return; }
  openModal('unit');
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Unit';
  setTimeout(() => {
    document.getElementById('f_property').value = un.prop(u);
    document.getElementById('f_unitno').value   = un.num(u);
    document.getElementById('f_type').value     = un.type(u);
    document.getElementById('f_rent').value     = un.rent(u);
    document.getElementById('f_desc').value     = un.desc(u);
  }, 60);
}

function editTenant(id) {
  const t = tenants.find(x => tn.id(x) === id);
  if (!t) { showToast('Tenant not found', 'error'); return; }
  openModal('tenant');
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Tenant';
  // For edit, allow any unit (not just vacant) so re-build unit select
  setTimeout(() => {
    document.getElementById('f_name').value    = tn.name(t);
    document.getElementById('f_phone').value   = tn.phone(t);
    document.getElementById('f_email').value   = tn.email(t);
    document.getElementById('f_idno').value    = tn.idno(t);
    document.getElementById('f_start').value   = tn.start(t);
    document.getElementById('f_end').value     = tn.end(t);
    document.getElementById('f_rent').value    = tn.rent(t);
    document.getElementById('f_deposit').value = tn.deposit(t);
    // For edit, populate unit select with ALL units (occupied too) so current one shows
    const unitSel = document.getElementById('f_unit');
    if (unitSel) {
      unitSel.innerHTML = '<option value="">— Select unit —</option>' +
        units.map(u => {
          const p = properties.find(x => pr.id(x) === un.prop(u)) || {};
          return `<option value="${un.id(u)}" ${un.id(u) === tn.unit(t) ? 'selected' : ''}>
            ${un.num(u)} – ${pr.name(p)} (${un.status(u)})
          </option>`;
        }).join('');
    }
  }, 60);
}

function editExpense(id) {
  const e = expenses.find(x => ex.id(x) === id);
  if (!e) { showToast('Expense not found', 'error'); return; }
  openModal('expense');
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Expense';
  setTimeout(() => {
    document.getElementById('f_property').value = ex.prop(e);
    document.getElementById('f_category').value = ex.cat(e);
    document.getElementById('f_desc').value     = ex.desc(e);
    document.getElementById('f_amount').value   = ex.amt(e);
    document.getElementById('f_date').value     = ex.date(e);
  }, 60);
}

// ── DELETE ────────────────────────────────────────────────────────────────────
function deleteLandlord(id) {
  const l = landlords.find(x => ll.id(x) === id);
  showPrompt(
    'Delete Landlord?',
    `Remove "${l ? ll.name(l) : id}"? This will mark them inactive.`,
    async () => {
      await fetch('/api/landlords/' + id, { method: 'DELETE' });
      showToast('Landlord removed', 'success');
      loadAllData();
    }
  );
}

// ── INVOICE / RECEIPT ACTIONS ─────────────────────────────────────────────────
function viewInvoice(id) { window.open('/api/invoices/' + id + '/pdf', '_blank'); }
function viewReceipt(id) { window.open('/api/receipts/' + id + '/pdf', '_blank'); }

async function payInvoice(id) {
  await fetch('/api/invoices/' + id + '/pay', { method: 'PUT' });
  showToast('Invoice marked as paid', 'success');
  loadAllData();
}

// Quick receipt directly from a rent record row
async function quickReceiptFromRent(rentId) {
  const r = rentData.find(x => rn.id(x) === rentId);
  if (!r) { showToast('Rent record not found', 'error'); return; }
  const t = tenants.find(x => tn.id(x) === rn.tenant(r)) || {};
  const u = units.find(x => un.id(x) === rn.unit(r))     || {};
  const payload = {
    rentId,
    tenantName:   tn.name(t),
    unitNumber:   un.num(u),
    amount:       rn.amount(r),
    month:        rn.month(r),
    year:         rn.year(r),
    paymentMethod:rn.method(r)
  };
  const res  = await fetch('/api/receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    showToast('Receipt generated!', 'success');
    await loadAllData();
    viewReceipt(data.id);
  } else {
    showToast(data.error || 'Failed to generate receipt', 'error');
  }
}

// ── PROMPT DIALOG ─────────────────────────────────────────────────────────────
function showPrompt(title, message, onYes) {
  document.getElementById('promptTitle').textContent   = title;
  document.getElementById('promptMessage').textContent = message;
  document.getElementById('promptYes').onclick = function() {
    closePrompt();
    onYes();
  };
  document.getElementById('promptOverlay').classList.add('active');
}
function closePrompt() {
  document.getElementById('promptOverlay').classList.remove('active');
}

// ── TABLE SEARCH FILTER ───────────────────────────────────────────────────────
function filterTable(tbodyId, query) {
  const q = query.toLowerCase();
  document.querySelectorAll('#' + tbodyId + ' tr').forEach(row => {
    if (row.querySelector('.empty-state')) return;
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3500);
}
