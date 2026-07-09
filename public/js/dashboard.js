// ManageMate Dashboard JS — extracted from dashboard.ejs
const CACHE = {
  _mem: {},
  _ttl: 5 * 60 * 1000,

  set(key, data) {
    this._mem[key] = { data, ts: Date.now() };
    try {
      sessionStorage.setItem('mm_' + key, JSON.stringify({ data, ts: Date.now() }));
    } catch(e) {}
  },

  get(key) {
    const m = this._mem[key];
    if (m && (Date.now() - m.ts) < this._ttl) return m.data;
    
    try {
      const stored = sessionStorage.getItem('mm_' + key);
      if (stored) {
        const parsed = JSON.parse(stored);
        if ((Date.now() - parsed.ts) < this._ttl) {
          this._mem[key] = parsed;
          return parsed.data;
        }
      }
    } catch(e) {}
    return null;
  },

  bust(keys = []) {
    keys.forEach(k => {
      delete this._mem[k];
      try { sessionStorage.removeItem('mm_' + k); } catch(e) {}
    });
  },

  bustAll() {
    this._mem = {};
    try {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith('mm_'))
        .forEach(k => sessionStorage.removeItem(k));
    } catch(e) {}
  }
};

// USER variable is set inline in dashboard.ejs via EJS template

// ── State ─────────────────────────────────────────────────────────────────────
let landlords=[], properties=[], units=[], tenants=[], rentData=[], allUsers=[], settings={};
let currentForm='', editingId=null, pendingLogoBase64=null;
let undoTimer=null, undoAction=null;
const pgState={rent:{page:1,pages:1},expenses:{page:1,pages:1},invoices:{page:1,pages:1},receipts:{page:1,pages:1}};

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtUGX = n => 'UGX ' + Number(n||0).toLocaleString();

// ── Accessors ─────────────────────────────────────────────────────────────────
const isActive = x=>(x.Status||x.status||'Active').toLowerCase()==='active';
const isVacant = u=>(u.Status||u.status||'Vacant').toLowerCase()==='vacant';
const ll={id:l=>l.ID||'',name:l=>l.Name||'',phone:l=>l.Phone||'',email:l=>l.Email||'',comm:l=>l['Commission Rate']||'10',status:l=>l.Status||'Active',addr:l=>l.Address||'',bank:l=>l['Bank Name']||'',acct:l=>l['Bank Account']||''};
const pr={id:p=>p.ID||'',name:p=>p.Name||'',llid:p=>p['Landlord ID']||'',llname:p=>p['Landlord Name']||'',addr:p=>p.Address||'',type:p=>p.Type||'Residential',units:p=>p['Total Units']||'0',status:p=>p.Status||'Active'};
const un={id:u=>u.ID||'',prop:u=>u['Property ID']||'',pname:u=>u['Property Name']||'',num:u=>u['Unit Number']||'',type:u=>u.Type||'Studio',rent:u=>u.Rent||'0',desc:u=>u.Description||'',status:u=>u.Status||'Vacant'};
const tn={id:t=>t.ID||'',name:t=>t.Name||'',phone:t=>t.Phone||'',email:t=>t.Email||'',idno:t=>t['ID Number']||'',unit:t=>t['Unit ID']||'',unum:t=>t['Unit Number']||'',start:t=>t['Lease Start']||'',end:t=>t['Lease End']||'',rent:t=>t['Rent Amount']||'0',deposit:t=>t.Deposit||'0',status:t=>t.Status||'Active'};
const rn={id:r=>r.ID||'',tenant:r=>r['Tenant ID']||'',tname:r=>r['Tenant Name']||'',unit:r=>r['Unit ID']||'',unum:r=>r['Unit Number']||'',amt:r=>r.Amount||'0',month:r=>r.Month||'',year:r=>r.Year||'',method:r=>r['Payment Method']||'Cash',ptype:r=>r['payment_type']||r.PaymentType||'Full',date:r=>r.Date||''};
const ex={id:e=>e.ID||'',prop:e=>e['Property ID']||'',pname:e=>e['Property Name']||'',cat:e=>e.Category||'',desc:e=>e.Description||'',amt:e=>e.Amount||'0',date:e=>e.Date||''};
const inv={id:i=>i.ID||'',type:i=>i.Type||'',eid:i=>i.EntityId||'',ename:i=>i.EntityName||'',desc:i=>i.Description||'',amt:i=>i.Amount||'0',month:i=>i.Month||'',year:i=>i.Year||'',status:i=>i.Status||'Unpaid'};
const rc={id:r=>r.ID||'',tenant:r=>r.TenantName||'',unit:r=>r.UnitNumber||'',amt:r=>r.Amount||'0',month:r=>r.Month||'',year:r=>r.Year||'',method:r=>r.PaymentMethod||'Cash',ptype:r=>r.payment_type||r.PaymentType||'Full',date:r=>r.Date||''};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  const u=document.getElementById('userName'); if(u) u.textContent=USER.name||USER.username;
  const r=document.getElementById('userRole'); if(r) r.textContent=USER.role;
  const d=document.getElementById('dashDate'); if(d) d.textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  if(USER.role==='Admin'){
    const a=document.getElementById('usersActionsBar'); if(a) a.style.display='flex';
    const s=document.getElementById('saveSettingsBtn'); if(s) s.style.display='block';
    const l=document.getElementById('logoRow'); if(l) l.style.display='flex';
  } else {
    ['navAdminLabel','navUsers','navArchive','navSettings'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  }
  updateClock();
  setInterval(updateClock, 60000);
  loadAllData();
});
// Live clock
function updateClock(){
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  const date = now.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  const el = document.getElementById('topbarTime');
  const de = document.getElementById('dashDate');
  if(el) el.textContent = time;
  if(de) de.textContent = date;
}

function logout(){window.location.href='/logout';}
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');}

// ── Lazy section loading ──────────────────────────────────────────────────────
const _sectionLoaded = new Set();

function showSection(id, e) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  
  const sec = document.getElementById('sec-' + id);
  if (sec) sec.classList.add('active');
  if (e && e.target) e.target.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');

  if (_sectionLoaded.has(id)) return;
  _sectionLoaded.add(id);

  if (id === 'arrears') { renderArrears(); renderMcArrears(); }
  if (id === 'landlords') { renderLandlords(); }
  if (id === 'properties') { renderProperties(); renderMcProperties(); }
  if (id === 'units') { renderUnits(); renderMcUnits(); }
  if (id === 'tenants') { renderTenants(); renderMcTenants(); }
}

// ── Data loading ──────────────────────────────────────────────────────────────
// ── Smart fetch with caching ──────────────────────────────────────────────────
const cfetch = async(url, fallback = []) => {
  const cached = CACHE.get(url);
  if (cached !== null) return cached;

  try {
    const data = await fetch(url, { credentials: 'include' }).then(r => r.json());
    CACHE.set(url, data);
    return data;
  } catch(e) {
    console.error('cfetch', url, e.message);
    return fallback;
  }
};

async function loadAllData() {
  try {
    const s = await cfetch('/api/stats', {});
    document.getElementById('statLandlords').textContent = s.landlords || 0;
    document.getElementById('statProperties').textContent = s.properties || 0;
    document.getElementById('statUnits').textContent = s.units || 0;
    document.getElementById('statTenants').textContent = s.tenants || 0;
    document.getElementById('statOccupied').textContent = s.occupied || 0;
    document.getElementById('statVacant').textContent = s.vacant || 0;
    document.getElementById('statRent').textContent = fmtUGX(s.totalRent);
    document.getElementById('statExpenses').textContent = fmtUGX(s.totalExpenses);
  } catch(e) { console.error('stats', e); }

  landlords = await cfetch('/api/landlords'); renderLandlords();
  properties = await cfetch('/api/properties'); renderProperties(); renderMcProperties();
  units = await cfetch('/api/units'); renderUnits(); renderMcUnits();
  tenants = await cfetch('/api/tenants'); renderTenants(); renderMcTenants();
  settings = await cfetch('/api/settings', {}); renderSettings(); applyBranding();
  if (USER.role === 'Admin') { allUsers = await cfetch('/api/users', []); renderUsers(); renderMcUsers(); }
  
  await Promise.all([loadPage('rent', 1), loadPage('expenses', 1), loadPage('invoices', 1), loadPage('receipts', 1)]);
  computeDashboardArrears();
  loadRentDueStatus();
}

// ── Rent due alert ────────────────────────────────────────────────────────────
async function loadRentDueStatus(){
  try{
    const d=await fetch('/api/rent/due-status',{credentials:'include'}).then(r=>r.json());
    const bar=document.getElementById('rentDueBar');
    if(!bar) return;
    if(d.dueToday){
      bar.style.display='flex'; bar.style.background='rgba(255,189,89,0.14)'; bar.style.borderColor='rgba(255,189,89,0.35)';
      bar.innerHTML=`<span style="font-size:18px">📅</span><strong style="color:#B76E00">Rent is due today (1st of the month).</strong><span style="color:#B76E00">&nbsp;${d.totalUnpaid} tenant${d.totalUnpaid!==1?'s':''} have not yet paid.</span>`;
    } else if(d.overdueCount>0){
      bar.style.display='flex'; bar.style.background='rgba(239,68,68,0.12)'; bar.style.borderColor='rgba(239,68,68,0.25)';
      bar.innerHTML=`<span style="font-size:18px">⚠️</span><strong style="color:#991b1b">${d.overdueCount} tenant${d.overdueCount!==1?'s':''} overdue</strong><span style="color:#991b1b">&nbsp;— rent was due on the 1st.</span><button onclick="showSection('arrears',event)" style="margin-left:auto;padding:7px 14px;background:#ef4444;color:#fff;border:none;border-radius:14px;font-size:12px;font-weight:700;cursor:pointer">View →</button>`;
    } else {
      bar.style.display='none';
    }
  }catch(e){console.error('due-status',e);}
}

// ── Arrears ───────────────────────────────────────────────────────────────────
function computeArrearsAll(){
  const now=new Date(); const arr=[];
  tenants.filter(t=>isActive(t)).forEach(t=>{
    const u=units.find(x=>un.id(x)===tn.unit(t));
    const rentAmt=parseFloat(tn.rent(t))||0; if(!rentAmt) return;
    const ls=tn.start(t)?new Date(tn.start(t)):null; if(!ls) return;
    const paid=new Set(rentData.filter(r=>rn.tenant(r)===tn.id(t)).map(r=>`${rn.year(r)}-${String(rn.month(r)).padStart(2,'0')}`));
    let due=0; const check=new Date(ls); check.setMonth(check.getMonth()+1);
    while(check<=now){const ym=`${check.getFullYear()}-${String(check.getMonth()+1).padStart(2,'0')}`;if(!paid.has(ym))due++;check.setMonth(check.getMonth()+1);}
    if(due>0) arr.push({t,u,rent:rentAmt,months:due,total:rentAmt*due});
  });
  return arr.sort((a,b)=>b.total-a.total);
}
function computeDashboardArrears(){
  const arr=computeArrearsAll();
  const total=arr.reduce((s,a)=>s+a.total,0);
  document.getElementById('statArrears').textContent=fmtUGX(total);
  document.getElementById('statArrearsCount').textContent=arr.length;
  const critical=arr.filter(a=>a.months>=2);
  const w=document.getElementById('criticalWidget');
  if(!critical.length){w.style.display='none';return;}
  w.style.display='block';
  document.getElementById('criticalSub').textContent=`— ${critical.length} tenant${critical.length!==1?'s':''} with 2+ months overdue`;
  document.getElementById('criticalList').innerHTML=critical.slice(0,5).map(a=>`
    <div class="arrears-item">
      <div><div class="ai-info">${tn.name(a.t)}</div><div class="ai-sub">Unit: ${a.u?un.num(a.u):'N/A'} &nbsp;|&nbsp; ${a.months} months</div></div>
      <div class="ai-amt">${fmtUGX(a.total)}</div>
    </div>`).join('');
}
function renderArrears(){
  const arr=computeArrearsAll(); const tb=document.getElementById('tArrears');
  if(!arr.length){tb.innerHTML=empty(8,'✅','All tenants are up to date');return;}
  tb.innerHTML=arr.map(a=>{
    const lv=a.months>=3?'danger':a.months>=2?'warning':'info';
    const lb=a.months>=3?'Critical':a.months>=2?'High':'Overdue';
    const p=a.u?properties.find(x=>pr.id(x)===un.prop(a.u)):null;
    return `<tr>
      <td><strong>${tn.name(a.t)}</strong></td>
      <td>${a.u?un.num(a.u):'N/A'}</td>
      <td>${p?pr.name(p):'—'}</td>
      <td>${fmtUGX(a.rent)}</td>
      <td>${a.months}</td>
      <td style="font-weight:700;color:var(--danger)">${fmtUGX(a.total)}</td>
      <td><span class="badge ${lv}">${lb}</span></td>
      <td class="actions"><button class="btn-edit" onclick="openModal('rent',null,'${tn.id(a.t)}')">Record Payment</button></td>
    </tr>`;
  }).join('');
}
function renderMcArrears() {
  const mc = document.getElementById('mcArrears');
  if (!mc) return;
  const arr = computeArrearsAll();
  if (!arr.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = arr.map(a => {
    const lv = a.months >= 3 ? 'danger' : a.months >= 2 ? 'warning' : 'info';
    const lb = a.months >= 3 ? 'Critical' : a.months >= 2 ? 'High' : 'Overdue';
    const p  = a.u ? properties.find(x => pr.id(x) === un.prop(a.u)) : null;
    return `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${tn.name(a.t)}</div>
        <div class="mc-sub">
          Unit: ${a.u ? un.num(a.u) : 'N/A'}
          ${p ? ` &nbsp;·&nbsp; ${pr.name(p)}` : ''}
        </div>
        <div class="mc-sub" style="margin-top:6px;display:flex;align-items:center;gap:8px">
          <span class="badge ${lv}">${lb}</span>
          <span>${a.months} month${a.months !== 1 ? 's' : ''} overdue</span>
        </div>
      </div>
      <div class="mc-right">
        <div class="mc-amount" style="color:#dc2626">${fmtUGX(a.total)}</div>
        <div class="mc-actions" style="margin-top:6px">
          <button class="btn-edit" onclick="openModal('rent',null,'${tn.id(a.t)}')">Pay</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Paginated loader ──────────────────────────────────────────────────────────
async function loadPage(type, page) {
  const urls = {
    rent: '/api/rent',
    expenses: '/api/expenses',
    invoices: '/api/invoices',
    receipts: '/api/receipts'
  };

  try {
    const url = `${urls[type]}?page=${page}&limit=50`;
    const res = await cfetch(url, []);

    const rows = Array.isArray(res) ? res : (res.data || []);
    const pages = Array.isArray(res) ? 1 : (res.pages || 1);
    pgState[type] = {
      page: Array.isArray(res) ? 1 : (res.page || 1),
      pages
    };

    if (type === 'rent') {
      rentData = rows;
      _renderRent();
      renderPg('rent', 'pgRent');
      computeDashboardArrears();
    }
    if (type === 'expenses') { _renderExpData(rows); renderPg('expenses', 'pgExpenses'); }
    if (type === 'invoices') { _renderInvData(rows); renderPg('invoices', 'pgInvoices'); }
    if (type === 'receipts') { _renderRcpData(rows); renderPg('receipts', 'pgReceipts'); }
  } catch(e) {
    console.error('loadPage error:', type, e.message);
  }
}
// Safe render wrappers — called from loadPage
function _renderRent()        { if(typeof renderRent      === 'function') renderRent();       else console.error('renderRent missing'); }
function _renderExpData(rows) { if(typeof renderExpData   === 'function') renderExpData(rows); else console.error('renderExpData missing'); }
function _renderInvData(rows) { if(typeof renderInvData   === 'function') renderInvData(rows); else console.error('renderInvData missing'); }
function _renderRcpData(rows) { if(typeof renderRcpData   === 'function') renderRcpData(rows); else console.error('renderRcpData missing'); }
function renderPg(type,cid){
  const{page,pages}=pgState[type]; const el=document.getElementById(cid); if(!el)return;
  if(pages<=1){el.style.display='none';return;}
  el.style.display='flex';
  const s=Math.max(1,page-2),e=Math.min(pages,page+2);
  let b='';
  if(s>1)b+=`<button onclick="loadPage('${type}',1)">1</button>`;
  if(s>2)b+=`<span style="padding:4px">…</span>`;
  for(let i=s;i<=e;i++)b+=`<button class="${i===page?'active':''}" onclick="loadPage('${type}',${i})">${i}</button>`;
  if(e<pages-1)b+=`<span style="padding:4px">…</span>`;
  if(e<pages)b+=`<button onclick="loadPage('${type}',${pages})">${pages}</button>`;
  el.innerHTML=`<span>Page ${page} of ${pages}</span><div class="pg-btns"><button onclick="loadPage('${type}',${page-1})" ${page<=1?'disabled':''}>← Prev</button>${b}<button onclick="loadPage('${type}',${page+1})" ${page>=pages?'disabled':''}>Next →</button></div>`;
}

// ── Render functions ──────────────────────────────────────────────────────────
const empty=(n,icon,msg)=>`<tr><td colspan="${n}"><div class="empty-state"><div class="icon">${icon}</div><h3>${msg}</h3></div></td></tr>`;

function renderLandlords(){
  const tb=document.getElementById('tLandlords');
  if(!landlords.length){tb.innerHTML=empty(7,'📋','No landlords yet');return;}
  tb.innerHTML=landlords.map(l=>`<tr>
    <td>${ll.id(l)}</td><td><strong>${ll.name(l)}</strong></td>
    <td>${ll.phone(l)}</td><td>${ll.email(l)}</td>
    <td>${ll.comm(l)}%</td>
    <td><span class="badge ${isActive(l)?'success':'danger'}">${ll.status(l)}</span></td>
    <td class="actions">
      <button class="btn-view" onclick="viewLandlordPortfolio('${ll.id(l)}')">View</button>
      <button class="btn-edit" onclick="editLandlord('${ll.id(l)}')">Edit</button>
      <button class="btn-delete" onclick="confirmDelete('landlord','${ll.id(l)}','${ll.name(l)}')">Delete</button>
    </td></tr>`).join('');
}
function renderProperties(){
  const tb=document.getElementById('tProperties');
  if(!properties.length){tb.innerHTML=empty(8,'🏠','No properties yet');return;}
  tb.innerHTML=properties.map(p=>`<tr>
    <td>${pr.id(p)}</td><td><strong>${pr.name(p)}</strong></td>
    <td>${pr.llname(p)}</td><td>${pr.addr(p)}</td>
    <td>${pr.type(p)}</td><td>${pr.units(p)}</td>
    <td><span class="badge ${isActive(p)?'success':'danger'}">${pr.status(p)}</span></td>
    <td class="actions">
      <button class="btn-edit" onclick="editProperty('${pr.id(p)}')">Edit</button>
      <button class="btn-delete" onclick="confirmDelete('property','${pr.id(p)}','${pr.name(p)}')">Delete</button>
    </td></tr>`).join('');
}
function renderUnits(){
  const tb=document.getElementById('tUnits');
  if(!units.length){tb.innerHTML=empty(7,'🚪','No units yet');return;}
  tb.innerHTML=units.map(u=>`<tr>
    <td>${un.id(u)}</td><td>${un.pname(u)}</td><td>${un.num(u)}</td>
    <td>${un.type(u)}</td><td>${fmtUGX(un.rent(u))}</td>
    <td><span class="badge ${isVacant(u)?'warning':'success'}">${un.status(u)}</span></td>
    <td class="actions">
      <button class="btn-edit" onclick="editUnit('${un.id(u)}')">Edit</button>
      <button class="btn-delete" onclick="confirmDelete('unit','${un.id(u)}','${un.num(u)}')">Delete</button>
    </td></tr>`).join('');
}
function renderTenants(){
  const tb=document.getElementById('tTenants');
  if(!tenants.length){tb.innerHTML=empty(8,'👥','No tenants yet');return;}
  tb.innerHTML=tenants.map(t=>`<tr>
    <td>${tn.id(t)}</td><td><strong>${tn.name(t)}</strong></td>
    <td>${tn.phone(t)}</td><td>${tn.unum(t)||'—'}</td>
    <td>${fmtUGX(tn.rent(t))}</td><td>${tn.end(t)||'—'}</td>
    <td><span class="badge ${isActive(t)?'success':'danger'}">${tn.status(t)}</span></td>
    <td class="actions">
      <button class="btn-edit" onclick="editTenant('${tn.id(t)}')">Edit</button>
      <button class="btn-delete" onclick="confirmDelete('tenant','${tn.id(t)}','${tn.name(t)}')">Delete</button>
    </td></tr>`).join('');
}
function renderUsers(){
  const tb=document.getElementById('tUsers');
  if(!allUsers.length){tb.innerHTML=empty(7,'🔐','No users found');return;}
  tb.innerHTML=allUsers.map(u=>`<tr>
    <td>${u.ID||''}</td><td>${u.Name||''}</td><td>${u.Username||''}</td>
    <td>${u.Email||''}</td>
    <td><span class="badge info">${u.Role||'User'}</span></td>
    <td><span class="badge ${(u.Status||'').toLowerCase()==='active'?'success':'danger'}">${u.Status||'Active'}</span></td>
    <td class="actions">${USER.role==='Admin'?`
      <button class="btn-edit" onclick="editUser('${u.ID||''}')">Edit</button>
      <button class="btn-pwd" onclick="setPassword('${u.ID||''}','${u.Name||u.Username||''}')">Set Pwd</button>
      <button class="btn-delete" onclick="deactivateUser('${u.ID||''}','${u.Name||''}')">Deactivate</button>`:'—'}
    </td></tr>`).join('');
}
function renderMcUsers() {
  const mc = document.getElementById('mcUsers');
  if (!mc) return;
  if (!allUsers.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = allUsers.map(u => `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${u.Name || '—'}</div>
        <div class="mc-sub">@${u.Username || '—'} &nbsp;·&nbsp; ${u.Email || '—'}</div>
        <div class="mc-sub" style="margin-top:6px;display:flex;align-items:center;gap:8px">
          <span class="badge info">${u.Role || 'User'}</span>
          <span class="badge ${(u.Status || '').toLowerCase() === 'active' ? 'success' : 'danger'}">${u.Status || 'Active'}</span>
        </div>
      </div>
      ${USER.role === 'Admin' ? `
      <div class="mc-right">
        <div class="mc-actions">
          <button class="btn-edit" onclick="editUser('${u.ID || ''}')">Edit</button>
          <button class="btn-pwd" onclick="setPassword('${u.ID || ''}','${u.Name || ''}')">Pwd</button>
        </div>
        <button class="btn-delete" onclick="deactivateUser('${u.ID || ''}','${u.Name || ''}')"
          style="width:100%;padding:0 12px;height:28px;border-radius:50px;border:none;font-size:11px;font-weight:600;cursor:pointer;background:#fee2e2;color:#991b1b;margin-top:4px">
          Deactivate
        </button>
      </div>` : ''}
    </div>`).join('');
}
function renderMcProperties() {
  const mc = document.getElementById('mcProperties');
  if (!mc) return;
  if (!properties.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = properties.map(p => `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${pr.name(p)}</div>
        <div class="mc-sub">${pr.llname(p) || '—'} &nbsp;·&nbsp; ${pr.type(p) || '—'}</div>
        <div class="mc-sub" style="margin-top:6px">${pr.addr(p) || '—'}</div>
        <div class="mc-sub" style="margin-top:6px;display:flex;align-items:center;gap:8px">
          Units: <strong>${pr.units(p)}</strong>
          <span class="badge ${isActive(p) ? 'success' : 'danger'}">${pr.status(p)}</span>
        </div>
      </div>
      <div class="mc-right">
        <button class="btn-edit" onclick="editProperty('${pr.id(p)}')">Edit</button>
        <button class="btn-delete" onclick="confirmDelete('property','${pr.id(p)}','${pr.name(p)}')"
          style="width:100%;padding:0 12px;height:28px;border-radius:50px;border:none;font-size:11px;font-weight:600;cursor:pointer;background:#fee2e2;color:#991b1b;margin-top:4px">
          Delete
        </button>
      </div>
    </div>`).join('');
}
function renderMcUnits() {
  const mc = document.getElementById('mcUnits');
  if (!mc) return;
  if (!units.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = units.map(u => `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${un.num(u)}</div>
        <div class="mc-sub">${un.pname(u) || '—'} &nbsp;·&nbsp; ${un.type(u) || '—'}</div>
        <div class="mc-sub" style="margin-top:6px">Rent: <strong>${fmtUGX(un.rent(u))}</strong></div>
        <div class="mc-sub" style="margin-top:6px">
          <span class="badge ${isVacant(u) ? 'warning' : 'success'}">${un.status(u)}</span>
        </div>
      </div>
      <div class="mc-right">
        <button class="btn-edit" onclick="editUnit('${un.id(u)}')">Edit</button>
        <button class="btn-delete" onclick="confirmDelete('unit','${un.id(u)}','${un.num(u)}')"
          style="width:100%;padding:0 12px;height:28px;border-radius:50px;border:none;font-size:11px;font-weight:600;cursor:pointer;background:#fee2e2;color:#991b1b;margin-top:4px">
          Delete
        </button>
      </div>
    </div>`).join('');
}
function renderMcTenants() {
  const mc = document.getElementById('mcTenants');
  if (!mc) return;
  if (!tenants.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = tenants.map(t => `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${tn.name(t)}</div>
        <div class="mc-sub">${tn.phone(t) || '—'} &nbsp;·&nbsp; ${tn.email(t) || '—'}</div>
        <div class="mc-sub" style="margin-top:6px">Unit: <strong>${tn.unum(t) || '—'}</strong></div>
        <div class="mc-sub" style="margin-top:6px">Rent: <strong>${fmtUGX(tn.rent(t))}</strong></div>
        <div class="mc-sub" style="margin-top:6px;display:flex;align-items:center;gap:8px">
          <span class="badge ${isActive(t) ? 'success' : 'danger'}">${tn.status(t)}</span>
        </div>
      </div>
      <div class="mc-right">
        <button class="btn-edit" onclick="editTenant('${tn.id(t)}')">Edit</button>
        <button class="btn-delete" onclick="confirmDelete('tenant','${tn.id(t)}','${tn.name(t)}')"
          style="width:100%;padding:0 12px;height:28px;border-radius:50px;border:none;font-size:11px;font-weight:600;cursor:pointer;background:#fee2e2;color:#991b1b;margin-top:4px">
          Delete
        </button>
      </div>
    </div>`).join('');
}
function renderRent() {
  const tb = document.getElementById('tRent');
  if (!rentData.length) { tb.innerHTML = empty(9,'💰','No payments recorded'); return; }
  tb.innerHTML = rentData.map(r => `<tr>
    <td>${rn.id(r)}</td>
    <td>${rn.tname(r)||rn.tenant(r)}</td>
    <td>${rn.unum(r)||rn.unit(r)}</td>
    <td><strong>${fmtUGX(rn.amt(r))}</strong></td>
    <td>${rn.month(r)} ${rn.year(r)}</td>
    <td><span class="badge ${rn.ptype(r)==='Full'?'success':'warning'}">${rn.ptype(r)}</span></td>
    <td>${rn.method(r)}</td>
    <td>${rn.date(r)}</td>
    <td class="actions">
      <button class="btn-receipt" onclick="generateAndViewReceipt('${rn.id(r)}')">🧾</button>
    </td></tr>`).join('');
  if (typeof renderMcRent === 'function') renderMcRent();
}

function renderExpData(rows) {
  const tb = document.getElementById('tExpenses');
  if (!rows.length) { tb.innerHTML = empty(7,'📑','No expenses recorded'); return; }
  tb.innerHTML = rows.map(e => `<tr>
    <td>${ex.id(e)}</td><td>${ex.pname(e)||'—'}</td>
    <td>${ex.cat(e)}</td><td>${ex.desc(e)}</td>
    <td>${fmtUGX(ex.amt(e))}</td><td>${ex.date(e)}</td>
    <td class="actions">
      <button class="btn-edit" onclick="editExpense('${ex.id(e)}')">Edit</button>
    </td></tr>`).join('');
  if (typeof renderMcExpenses === 'function') renderMcExpenses(rows);
}

function renderInvData(rows) {
  const tb = document.getElementById('tInvoices');
  if (!rows.length) { tb.innerHTML = empty(8,'📄','No invoices yet'); return; }
  tb.innerHTML = rows.map(i => `<tr>
    <td>${inv.id(i)}</td><td>${inv.type(i)}</td>
    <td>${inv.ename(i)}</td><td>${inv.desc(i)}</td>
    <td>${fmtUGX(inv.amt(i))}</td>
    <td>${inv.month(i)} ${inv.year(i)}</td>
    <td><span class="badge ${inv.status(i).toLowerCase()==='paid'?'success':'danger'}">${inv.status(i)}</span></td>
    <td class="actions">
      <button class="btn-view" onclick="window.open('/api/invoices/${inv.id(i)}/pdf','_blank')">View</button>
      ${inv.status(i)!=='Paid'?`<button class="btn-edit" onclick="payInvoice('${inv.id(i)}')">Pay</button>`:''}
    </td></tr>`).join('');
  if (typeof renderMcInvoices === 'function') renderMcInvoices(rows);
}

function renderRcpData(rows) {
  const tb = document.getElementById('tReceipts');
  if (!rows.length) { tb.innerHTML = empty(9,'🧾','No receipts yet'); return; }
  tb.innerHTML = rows.map(r => `<tr>
    <td>${rc.id(r)}</td><td>${rc.tenant(r)}</td><td>${rc.unit(r)}</td>
    <td>${fmtUGX(rc.amt(r))}</td>
    <td>${rc.month(r)} ${rc.year(r)}</td>
    <td><span class="badge ${rc.ptype(r)==='Full'?'success':'warning'}">${rc.ptype(r)}</span></td>
    <td>${rc.method(r)}</td><td>${rc.date(r)}</td>
    <td class="actions">
      <button class="btn-view" onclick="window.open('/api/receipts/${rc.id(r)}/pdf','_blank')">View</button>
      <button class="btn-wa" onclick="generateWhatsApp('${rc.id(r)}')">📱</button>
    </td></tr>`).join('');
  if (typeof renderMcReceipts === 'function') renderMcReceipts(rows);
}
// ── Settings ──────────────────────────────────────────────────────────────────
const SETTING_LABELS={company_name:'Company Name',company_address:'Address',company_phone:'Phone',company_email:'Email',currency:'Currency',vat_rate:'VAT Rate (%)'};
function renderSettings(){
  if(settings.company_logo) document.getElementById('logoPreviewWrap').innerHTML=`<img class="logo-preview" src="${settings.company_logo}">`;
  const form=document.getElementById('settingsForm');
  if(USER.role!=='Admin'){
    const entries=Object.entries(settings).filter(([k])=>k!=='company_logo');
    form.innerHTML=entries.length?entries.map(([k,v])=>`<div class="settings-row"><label>${SETTING_LABELS[k]||k}</label><span>${v}</span></div>`).join(''):'<div style="padding:20px;color:var(--text-light)">No settings configured</div>';
    return;
  }
  const keys=['company_name','company_address','company_phone','company_email','currency','vat_rate'];
  form.innerHTML=keys.map(k=>`<div class="settings-row"><label for="s_${k}">${SETTING_LABELS[k]||k}</label><input id="s_${k}" value="${(settings[k]||'').replace(/"/g,'&quot;')}" placeholder="${SETTING_LABELS[k]||k}"></div>`).join('');
}
function applyBranding(){
  const name = settings.company_name || 'ManageMate';
  document.title = name + ' — ManageMate';

  if(settings.company_logo){
    const logo = document.getElementById('sidebarLogo');
    if(logo){
      const txt = logo.querySelector('.logo-text');
      if(txt) txt.style.display = 'none';
      if(!logo.querySelector('.logo-img')){
        const img = document.createElement('img');
        img.className = 'logo-img';
        img.src = settings.company_logo;
        img.style.cssText = 'width:34px;height:34px;object-fit:contain;border-radius:8px;flex-shrink:0';
        logo.insertBefore(img, logo.firstChild);
      }
    }
    const wrap = document.getElementById('logoPreviewWrap');
    if(wrap) wrap.innerHTML = `![](${settings.company_logo})`;
  }
}
async function saveSettings(){
  const btn=document.getElementById('saveSettingsBtn');
  btn.textContent='Saving…'; btn.disabled=true;
  try{
    const payload={};
    ['company_name','company_address','company_phone','company_email','currency','vat_rate'].forEach(k=>{const el=document.getElementById('s_'+k);if(el)payload[k]=el.value;});
    const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(payload)});
    const d=await r.json();
    if(d.success){
      if(pendingLogoBase64){
        await fetch('/api/settings/logo',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({logoBase64:pendingLogoBase64})});
        pendingLogoBase64=null;
      }
      showToast('Settings saved!','success');
      settings=await fetch('/api/settings',{credentials:'include'}).then(r=>r.json());
      applyBranding();
    } else showToast(d.error||'Failed','error');
  }catch(e){showToast('Error: '+e.message,'error');}
  btn.textContent='💾 Save Settings'; btn.disabled=false;
}
function handleLogoUpload(event){
  const file=event.target.files[0]; if(!file) return;
  if(file.size>800000){showToast('Logo too large — max 800KB','error');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    pendingLogoBase64=e.target.result;
    document.getElementById('logoPreviewWrap').innerHTML=`<img class="logo-preview" src="${e.target.result}">`;
    showToast('Logo ready — click Save Settings to apply','info');
  };
  reader.readAsDataURL(file);
}

// ── Archive ───────────────────────────────────────────────────────────────────
async function loadArchive(){
  const type=document.getElementById('archiveTypeFilter')?.value||'';
  const search=document.getElementById('archiveSearch')?.value||'';
  const tb=document.getElementById('tArchive');
  tb.innerHTML=`<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-light)">Loading…</td></tr>`;
  try{
    const rows=await fetch(`/api/archive?type=${type}&search=${encodeURIComponent(search)}`,{credentials:'include'}).then(r=>r.json());
    if(!rows.length){tb.innerHTML=empty(5,'🗃️','No archived records found');return;}
    tb.innerHTML=rows.map(r=>`<tr>
      <td>${r.deleted_at}</td>
      <td><span class="badge info">${r.entity_type}</span></td>
      <td>${r.entity_id}</td>
      <td>${r.entity_label}</td>
      <td>${r.deleted_by||'—'}</td>
    </tr>`).join('');
  }catch(e){tb.innerHTML=empty(5,'❌','Failed to load archive');}
}
function renderMcArchive(rows) {
  const mc = document.getElementById('mcArchive');
  if (!mc) return;
  if (!rows || !rows.length) { mc.innerHTML = ''; return; }
  mc.innerHTML = rows.map(r => `
    <div class="mobile-card">
      <div class="mc-main">
        <div class="mc-title">${r.entity_label || '—'}</div>
        <div class="mc-sub">
          <span class="badge info">${r.entity_type}</span>
          &nbsp; ${r.entity_id}
        </div>
        <div class="mc-sub" style="margin-top:4px;font-size:11px;color:#64748b">
          Deleted ${r.deleted_at} by ${r.deleted_by || '—'}
        </div>
      </div>
    </div>`).join('');
}
// ── Modal opener ──────────────────────────────────────────────────────────────
function openModal(type,e,prefillTenantId=null){
  currentForm=type; editingId=null;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalBox').className=(['bulk_unit','bulk_invoice'].includes(type)?'modal wide':'modal');
  const body=document.getElementById('modalBody');
  const title=document.getElementById('modalTitle');

  const llOpts=landlords.filter(isActive).map(l=>`<option value="${ll.id(l)}">${ll.name(l)}</option>`).join('');
  const propOpts=properties.filter(isActive).map(p=>`<option value="${pr.id(p)}">${pr.name(p)}</option>`).join('');
  const vacOpts=units.filter(isVacant).map(u=>{const p=properties.find(x=>pr.id(x)===un.prop(u))||{};return `<option value="${un.id(u)}" data-rent="${un.rent(u)}">${un.num(u)} – ${pr.name(p)||un.prop(u)}</option>`;}).join('');
  const tnOpts=tenants.filter(isActive).map(t=>`<option value="${tn.id(t)}" data-unit="${tn.unit(t)}" data-rent="${tn.rent(t)}">${tn.name(t)}</option>`).join('');
  const now=new Date();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mOpts=months.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}" ${i===now.getMonth()?'selected':''}>${m}</option>`).join('');
  const yr=now.getFullYear();
  const tod=now.toISOString().split('T')[0];
  const CATS=['Maintenance','Utilities','Insurance','Property Tax','Legal Fees','Marketing','Cleaning','Security','Repairs','Renovation','Landscaping','Management Fees','Commission','Other'];
  const catOpts=CATS.map(c=>`<option>${c}</option>`).join('');
  const UTYPES=['Studio','1 Bedroom','2 Bedroom','3 Bedroom','4+ Bedroom','Shop','Office','Warehouse'];
  const utOpts=UTYPES.map(t=>`<option>${t}</option>`).join('');

  const FORMS={
    landlord:()=>{ title.textContent='Add Landlord'; return `<div class="form-grid">
      <div class="form-group full"><label>Full Name *</label><input id="f_name" required placeholder="e.g. John Mukasa"></div>
      <div class="form-group"><label>Phone</label><input id="f_phone" placeholder="+256 7XX XXX XXX"></div>
      <div class="form-group"><label>Email</label><input id="f_email" type="email"></div>
      <div class="form-group full"><label>Address</label><input id="f_address"></div>
      <div class="form-group"><label>Bank Name</label><input id="f_bank"></div>
      <div class="form-group"><label>Bank Account No.</label><input id="f_account"></div>
      <div class="form-group"><label>Commission %</label><input id="f_commission" type="number" value="10" min="0" max="100"></div>
    </div>`; },

    property:()=>{ title.textContent='Add Property'; return `<div class="form-grid">
      <div class="form-group full"><label>Property Name *</label><input id="f_name" required placeholder="e.g. Bugolobi Apartments"></div>
      <div class="form-group full"><label>Landlord *</label><select id="f_landlord"><option value="">— Select landlord —</option>${llOpts||'<option disabled>No landlords — add one first</option>'}</select></div>
      <div class="form-group full"><label>Address / Location</label><input id="f_address" placeholder="e.g. Plot 12, Nakasero Road"></div>
      <div class="form-group"><label>Property Type</label><select id="f_type"><option>Residential</option><option>Commercial</option><option>Mixed</option><option>Industrial</option></select></div>
    </div>`; },

    unit:()=>{ title.textContent='Add Unit'; return `<div class="form-grid">
      <div class="form-group full"><label>Property *</label><select id="f_property"><option value="">— Select property —</option>${propOpts||'<option disabled>No properties — add one first</option>'}</select></div>
      <div class="form-group"><label>Unit Number / Name *</label><input id="f_unitno" required placeholder="e.g. A1, Shop 3"></div>
      <div class="form-group"><label>Unit Type</label><select id="f_type">${utOpts}</select></div>
      <div class="form-group"><label>Monthly Rent (UGX)</label><input id="f_rent" type="number" placeholder="0" min="0"></div>
      <div class="form-group full"><label>Description / Notes</label><textarea id="f_desc" placeholder="Floor, features, parking…"></textarea></div>
    </div>`; },

    bulk_unit:()=>{ title.textContent='Add Units in Bulk'; return `<div class="form-grid">
      <div class="form-group full"><label>Property *</label><select id="f_property" onchange="previewUnits()"><option value="">— Select property —</option>${propOpts||'<option disabled>No properties — add one first</option>'}</select></div>
      <div class="form-group"><label>Unit Type *</label><select id="f_type" onchange="previewUnits()">${utOpts}</select></div>
      <div class="form-group"><label>Monthly Rent (UGX) *</label><input id="f_rent" type="number" placeholder="e.g. 500000" min="0" oninput="previewUnits()"></div>
      <div class="form-group"><label>Label Prefix</label><input id="f_prefix" value="Unit" placeholder="e.g. Apt, Shop" oninput="previewUnits()"></div>
      <div class="form-group"><label>Start Number</label><input id="f_start" type="number" value="1" min="1" oninput="previewUnits()"></div>
      <div class="form-group"><label>Number of Units *</label><input id="f_count" type="number" placeholder="e.g. 10" min="1" max="100" oninput="previewUnits()"></div>
      <div class="form-group full"><label>Preview</label>
        <div class="unit-preview" id="bulkPreview"><em style="color:var(--text-light);font-size:12px">Fill in fields above to preview unit names</em></div>
      </div>
    </div>`; },

    tenant:()=>{ title.textContent='Add Tenant'; return `<div class="form-grid">
      <div class="form-group full"><label>Full Name *</label><input id="f_name" required></div>
      <div class="form-group"><label>Phone *</label><input id="f_phone" required placeholder="+256 7XX XXX XXX"></div>
      <div class="form-group"><label>Email</label><input id="f_email" type="email"></div>
      <div class="form-group"><label>National ID / Passport</label><input id="f_idno"></div>
      <div class="form-group full"><label>Vacant Unit *</label><select id="f_unit" onchange="autoFillRent()"><option value="">— Select vacant unit —</option>${vacOpts||'<option disabled>No vacant units available</option>'}</select></div>
      <div class="form-group"><label>Lease Start</label><input id="f_start" type="date" value="${tod}"></div>
      <div class="form-group"><label>Lease End</label><input id="f_end" type="date"></div>
      <div class="form-group"><label>Monthly Rent (UGX)</label><input id="f_rent" type="number" placeholder="Auto-fills from unit"></div>
      <div class="form-group"><label>Security Deposit (UGX)</label><input id="f_deposit" type="number" placeholder="0"></div>
      <div class="form-group full" style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border)">
        <label style="font-size:12px;color:var(--primary);font-weight:700">EMERGENCY CONTACT</label>
      </div>
      <div class="form-group"><label>Emergency Contact Name</label><input id="f_emname" placeholder="Full name"></div>
      <div class="form-group"><label>Emergency Contact Phone</label><input id="f_emphone" placeholder="+256 7XX XXX XXX"></div>
      <div class="form-group full" style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border)">
        <label style="font-size:12px;color:var(--primary);font-weight:700">NEXT OF KIN</label>
      </div>
      <div class="form-group"><label>Next of Kin Name</label><input id="f_nokin" placeholder="Full name"></div>
      <div class="form-group"><label>Next of Kin Phone</label><input id="f_nokinphone" placeholder="+256 7XX XXX XXX"></div>
      <div class="form-group"><label>Relationship</label><input id="f_nokinrel" placeholder="e.g. Spouse, Parent, Sibling"></div>
    </div>`; },

    rent:()=>{ title.textContent='Record Rent Payment'; return `<div class="form-grid">
      <div class="form-group full"><label>Tenant *</label><select id="f_tenant" onchange="autoFillUnit()"><option value="">— Select tenant —</option>${tnOpts||'<option disabled>No active tenants</option>'}</select></div>
      <div class="form-group"><label>Unit (auto-filled)</label><input id="f_unit" readonly style="background:rgba(33,147,119,0.05)"></div>
      <div class="form-group"><label>Expected Rent (UGX)</label><input id="f_expected" type="number" placeholder="0" style="background:rgba(33,147,119,0.05)" readonly></div>
      <div class="form-group"><label>Amount Paid (UGX) *</label><input id="f_amount" type="number" required placeholder="0" oninput="checkPartial()"></div>
      <div class="form-group"><label>Month</label><select id="f_month">${mOpts}</select></div>
      <div class="form-group"><label>Year</label><input id="f_year" type="number" value="${yr}"></div>
      <div class="form-group"><label>Payment Method</label><select id="f_method"><option>Cash</option><option>Bank Transfer</option><option>Mobile Money</option><option>Cheque</option><option>Card</option></select></div>
      <div class="form-group"><label>Payment Type</label>
        <select id="f_ptype"><option value="Full">Full Payment</option><option value="Partial">Partial Payment</option></select>
      </div>
      <div class="form-group full"><label>Reference / Transaction ID</label><input id="f_ref" placeholder="MTN ref, cheque no., etc."></div>
      <div class="form-group full" id="balanceInfo" style="display:none">
        <div style="background:rgba(255,189,89,0.14);border:1px solid rgba(255,189,89,0.35);border-radius:14px;padding:14px;font-size:13px;color:#B76E00">
          ⚠️ <strong id="balanceInfoText">Balance will be carried forward.</strong>
        </div>
      </div>
    </div>`; },

    expense:()=>{ title.textContent='Add Expense'; return `<div class="form-grid">
      <div class="form-group full"><label>Property (optional)</label><select id="f_property"><option value="">— General / Not property-specific —</option>${propOpts}</select></div>
      <div class="form-group"><label>Category *</label><select id="f_category">${catOpts}</select></div>
      <div class="form-group full"><label>Description *</label><input id="f_desc" required placeholder="What was this expense for?"></div>
      <div class="form-group"><label>Amount (UGX) *</label><input id="f_amount" type="number" required placeholder="0"></div>
      <div class="form-group"><label>Date</label><input id="f_date" type="date" value="${tod}"></div>
    </div>`; },

    invoice:()=>{ title.textContent='Create Invoice'; return `<div class="form-grid">
      <div class="form-group full"><label>Invoice Type *</label><select id="f_invType" onchange="updateInvoiceEntity()"><option value="">— Select type —</option><option value="landlord">Landlord Management Fee</option><option value="tenant">Tenant Rent Invoice</option></select></div>
      <div class="form-group full"><label>Bill To *</label><select id="f_entity" disabled><option value="">Select type first…</option></select></div>
      <div class="form-group full"><label>Description</label><input id="f_desc" maxlength="255" placeholder="e.g. Management fee for June 2025"></div>
      <div class="form-group"><label>Amount (UGX) *</label><input id="f_amount" type="number" required placeholder="0"></div>
      <div class="form-group"><label>Month</label><select id="f_month">${mOpts}</select></div>
      <div class="form-group"><label>Year</label><input id="f_year" type="number" value="${yr}"></div>
    </div>`; },
    custom_invoice:()=>{ title.textContent='Custom Service Invoice'; return `<div class="form-grid">
      <div class="form-group full"><label>Client / Company Name *</label><input id="f_clientname" required placeholder="e.g. Acme Ltd, John Mukasa"></div>
      <div class="form-group"><label>Client Email</label><input id="f_clientemail" type="email" placeholder="client@email.com"></div>
      <div class="form-group"><label>Client Address</label><input id="f_clientaddr" placeholder="Physical / postal address"></div>
      <div class="form-group full"><label>Service Title *</label><input id="f_servicetitle" required placeholder="e.g. Property Advisory Fee, Inspection Fee"></div>
      <div class="form-group full"><label>Service Description</label><textarea id="f_desc" maxlength="500" placeholder="Details of the service provided…"></textarea></div>
      <div class="form-group"><label>Total Amount (UGX) *</label><input id="f_amount" type="number" required placeholder="0"></div>
      <div class="form-group"><label>Month</label><select id="f_month">${mOpts}</select></div>
      <div class="form-group"><label>Year</label><input id="f_year" type="number" value="${yr}"></div>
    </div>`; },
    bulk_invoice:()=>{ title.textContent='Bulk Management Fee Invoices'; return `<div class="form-grid">
      <div class="form-group"><label>Month *</label><select id="f_month">${mOpts}</select></div>
      <div class="form-group"><label>Year *</label><input id="f_year" type="number" value="${yr}"></div>
      <div class="form-group full"><label>Description (optional)</label><input id="f_desc" maxlength="255" placeholder="e.g. Management fee for May 2025"></div>
      <div class="form-group full"><label>Override Amount per Landlord (leave blank to auto-calculate)</label><input id="f_override" type="number" placeholder="Leave blank for auto-calculation per commission rate"></div>
    </div>
    <p style="color:var(--text-light);font-size:12px;margin-top:12px">Creates one management fee invoice per active landlord based on their commission rate and rent collected in the selected month.</p>`; },

    user:()=>{ title.textContent='Add User'; return `<div class="form-grid">
      <div class="form-group full"><label>Full Name *</label><input id="f_name" required></div>
      <div class="form-group"><label>Username *</label><input id="f_username" required placeholder="e.g. sarah.nambi"></div>
      <div class="form-group"><label>Email</label><input id="f_email" type="email"></div>
      <div class="form-group"><label>Role *</label><select id="f_role"><option value="User">User</option><option value="Admin">Admin</option></select></div>
      <div class="form-group"><label>Password *</label><input id="f_password" type="password" required placeholder="Min 6 characters"></div>
      <div class="form-group"><label>Confirm Password *</label><input id="f_password2" type="password" required placeholder="Repeat password"></div>
    </div>`; },

    rent_increase:()=>{ return ''; }, // handled in openRentIncreaseModal
    report_portfolio:()=>{ return ''; },
    report_landlord:()=>{ return ''; },
    report_tenant:()=>{ return ''; },
  };

  body.innerHTML=(FORMS[type]||(() => '<p>Unknown form type</p>'))();

  if(type==='rent'&&prefillTenantId){
    setTimeout(()=>{const sel=document.getElementById('f_tenant');if(sel){sel.value=prefillTenantId;autoFillUnit();}},60);
  }
}

function previewUnits(){
  const prefix=(document.getElementById('f_prefix')?.value||'Unit').trim();
  const start=parseInt(document.getElementById('f_start')?.value)||1;
  const count=parseInt(document.getElementById('f_count')?.value)||0;
  const el=document.getElementById('bulkPreview'); if(!el) return;
  if(!count||count<1){el.innerHTML='<em style="color:var(--text-light);font-size:12px">Enter a count to preview</em>';return;}
  if(count>100){el.innerHTML='<em style="color:var(--danger);font-size:12px">Max 100 units at once</em>';return;}
  const names=[];
  for(let i=0;i<count;i++) names.push(`${prefix} ${start+i}`);
  el.innerHTML=names.map(n=>`<span class="preview-tag">${n}</span>`).join('');
}
function autoFillUnit(){
  const sel=document.getElementById('f_tenant'); if(!sel) return;
  const opt=sel.selectedOptions[0];
  const ui=document.getElementById('f_unit'); if(ui) ui.value=opt?.dataset?.unit||'';
  const rent=opt?.dataset?.rent||'';
  const ai=document.getElementById('f_amount'); if(ai&&!ai.value&&rent) ai.value=rent;
  const ei=document.getElementById('f_expected'); if(ei) ei.value=rent;
  checkPartial();
}
function autoFillRent(){
  const sel=document.getElementById('f_unit'); if(!sel) return;
  const opt=sel.selectedOptions[0];
  const ri=document.getElementById('f_rent'); if(ri&&!ri.value&&opt?.dataset?.rent) ri.value=opt.dataset.rent;
}
function checkPartial(){
  const paid=parseFloat(document.getElementById('f_amount')?.value||0);
  const exp=parseFloat(document.getElementById('f_expected')?.value||0);
  const infoDiv=document.getElementById('balanceInfo');
  const infoText=document.getElementById('balanceInfoText');
  if(!infoDiv||!infoText) return;
  if(exp>0&&paid<exp){
    const bal=exp-paid;
    infoDiv.style.display='block';
    infoText.textContent=`Balance of ${fmtUGX(bal)} will be carried forward to next month.`;
    const ptSel=document.getElementById('f_ptype');
    if(ptSel) ptSel.value='Partial';
  } else {
    infoDiv.style.display='none';
  }
}
function updateInvoiceEntity(){
  const t=document.getElementById('f_invType')?.value;
  const sel=document.getElementById('f_entity'); if(!sel) return;
  sel.disabled=false;
  if(t==='landlord') sel.innerHTML='<option value="">— Select landlord —</option>'+landlords.filter(isActive).map(l=>`<option value="${ll.id(l)}">${ll.name(l)}</option>`).join('');
  else if(t==='tenant') sel.innerHTML='<option value="">— Select tenant —</option>'+tenants.filter(isActive).map(t=>`<option value="${tn.id(t)}">${tn.name(t)}</option>`).join('');
  else{sel.disabled=true;sel.innerHTML='<option>Select type first…</option>';}
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('active');
  const b=document.getElementById('modalSave');
  b.textContent='Save';
  b.disabled=false;
  b.onclick=saveForm;       
  currentForm='';
  editingId=null;
}
const gv=id=>{const e=document.getElementById(id);return e?e.value.trim():'';};

// ── Save form ─────────────────────────────────────────────────────────────────
async function saveForm(){
  const btn=document.getElementById('modalSave');
  btn.textContent='Saving…'; btn.disabled=true;
  try{
    let payload={},endpoint='',method='POST';
    switch(currentForm){
      case 'landlord':
        if(!gv('f_name')){showToast('Name required','error');break;}
        endpoint=editingId?`/api/landlords/${editingId}`:'/api/landlords';
        method=editingId?'PUT':'POST';
        payload={name:gv('f_name'),phone:gv('f_phone'),email:gv('f_email'),address:gv('f_address'),bankName:gv('f_bank'),bankAccount:gv('f_account'),commissionRate:gv('f_commission')};
        break;
      case 'property':
        if(!gv('f_name')){showToast('Property name required','error');break;}
        if(!gv('f_landlord')){showToast('Please select a landlord','error');break;}
        endpoint=editingId?`/api/properties/${editingId}`:'/api/properties';
        method=editingId?'PUT':'POST';
        payload={name:gv('f_name'),landlordId:gv('f_landlord'),address:gv('f_address'),type:gv('f_type')};
        break;
      case 'unit':
        if(!gv('f_property')){showToast('Please select a property','error');break;}
        if(!gv('f_unitno')){showToast('Unit number required','error');break;}
        endpoint=editingId?`/api/units/${editingId}`:'/api/units';
        method=editingId?'PUT':'POST';
        payload={propertyId:gv('f_property'),unitNumber:gv('f_unitno'),type:gv('f_type'),rent:gv('f_rent'),description:gv('f_desc')};
        break;
      case 'bulk_unit':{
        if(!gv('f_property')){showToast('Please select a property','error');break;}
        if(!gv('f_count')){showToast('Enter number of units','error');break;}
        if(!gv('f_rent')){showToast('Monthly rent required','error');break;}
        const prefix=(gv('f_prefix')||'Unit').trim();
        const start=parseInt(gv('f_start'))||1;
        const count=parseInt(gv('f_count'));
        if(count<1||count>100){showToast('Enter 1–100 units','error');break;}
        const unitList=[];
        for(let i=0;i<count;i++) unitList.push({unitNumber:`${prefix} ${start+i}`,type:gv('f_type'),rent:gv('f_rent'),description:''});
        endpoint='/api/units/bulk'; payload={propertyId:gv('f_property'),units:unitList};
        break;
      }
      case 'tenant':
        if(!gv('f_name')){showToast('Name required','error');break;}
        if(!gv('f_phone')){showToast('Phone required','error');break;}
        if(!gv('f_unit')){showToast('Please select a unit','error');break;}
        endpoint=editingId?`/api/tenants/${editingId}`:'/api/tenants';
        method=editingId?'PUT':'POST';
        payload={name:gv('f_name'),phone:gv('f_phone'),email:gv('f_email'),idNumber:gv('f_idno'),unitId:gv('f_unit'),leaseStart:gv('f_start'),leaseEnd:gv('f_end'),rentAmount:gv('f_rent'),deposit:gv('f_deposit'),emergencyName:gv('f_emname'),emergencyPhone:gv('f_emphone'),nextOfKinName:gv('f_nokin'),nextOfKinPhone:gv('f_nokinphone'),nextOfKinRel:gv('f_nokinrel')};
        break;
      case 'rent':
        if(!gv('f_tenant')){showToast('Please select a tenant','error');break;}
        if(!gv('f_amount')){showToast('Amount required','error');break;}
        endpoint='/api/rent/v2';
        payload={tenantId:gv('f_tenant'),unitId:gv('f_unit'),amount:gv('f_amount'),expectedAmount:gv('f_expected'),month:gv('f_month'),year:gv('f_year'),paymentMethod:gv('f_method'),reference:gv('f_ref'),paymentType:gv('f_ptype')};
        break;
      case 'expense':
        if(!gv('f_desc')){showToast('Description required','error');break;}
        if(!gv('f_amount')){showToast('Amount required','error');break;}
        endpoint=editingId?`/api/expenses/${editingId}`:'/api/expenses';
        method=editingId?'PUT':'POST';
        payload={propertyId:gv('f_property'),category:gv('f_category'),description:gv('f_desc'),amount:gv('f_amount'),date:gv('f_date')};
        break;
      case 'invoice':{
        if(!gv('f_invType')||!gv('f_entity')){showToast('Select type and entity','error');break;}
        if(!gv('f_amount')){showToast('Amount required','error');break;}
        const itype=gv('f_invType'),ieid=gv('f_entity');
        const iname=itype==='landlord'?(landlords.find(x=>ll.id(x)===ieid)||{}).Name||'':(tenants.find(x=>tn.id(x)===ieid)||{}).Name||'';
        endpoint='/api/invoices/v2';
        payload={type:itype,entityId:ieid,entityName:iname,description:gv('f_desc'),amount:gv('f_amount'),month:gv('f_month'),year:gv('f_year')};
        break;
      }
      case 'custom_invoice':
        if(!gv('f_clientname')){showToast('Client name required','error');break;}
        if(!gv('f_servicetitle')){showToast('Service title required','error');break;}
        if(!gv('f_amount')){showToast('Amount required','error');break;}
        endpoint='/api/invoices/custom';
        payload={clientName:gv('f_clientname'),clientEmail:gv('f_clientemail'),clientAddress:gv('f_clientaddr'),serviceTitle:gv('f_servicetitle'),description:gv('f_desc'),amount:gv('f_amount'),month:gv('f_month'),year:gv('f_year')};
        break;
      case 'bulk_invoice':
        if(!gv('f_month')||!gv('f_year')){showToast('Month and year required','error');break;}
        endpoint='/api/invoices/bulk';
        payload={month:gv('f_month'),year:gv('f_year'),description:gv('f_desc'),overrideAmount:gv('f_override')};
        break;
      case 'user':
        if(!gv('f_name')){showToast('Full name required','error');break;}
        if(!gv('f_username')){showToast('Username required','error');break;}
        if(!editingId&&!gv('f_password')){showToast('Password required','error');break;}
        if(!editingId&&gv('f_password')!==gv('f_password2')){showToast('Passwords do not match','error');break;}
        if(!editingId&&gv('f_password').length<6){showToast('Password must be at least 6 characters','error');break;}
        endpoint=editingId?`/api/users/${editingId}`:'/api/users';
        method=editingId?'PUT':'POST';
        payload={username:gv('f_username'),fullName:gv('f_name'),email:gv('f_email'),role:gv('f_role'),password:gv('f_password')};
        break;
      case 'rent_increase':
        if(!gv('f_newrent')){showToast('New rent required','error');break;}
        if(!gv('f_effdate')){showToast('Effective date required','error');break;}
        endpoint='/api/rent-increase';
        payload={unitId:editingId,newRent:gv('f_newrent'),effectiveDate:gv('f_effdate'),notes:gv('f_notes')};
        break;
      default:
        showToast('Unknown form','error'); btn.textContent='Save'; btn.disabled=false; return;
    }
    if(!endpoint){btn.textContent='Save';btn.disabled=false;return;}

    const res=await fetch(endpoint,{method,headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(payload)});
    const data=await res.json();

    if(data.success){
      const sf=currentForm,sid=data.id,sp={...payload};
      showToast(sf==='bulk_unit'?`${data.count} units created!`:sf==='bulk_invoice'?`${data.count} invoices created!`:'Saved successfully!','success');
      
      // Bust relevant cache keys to force fresh data reload
      const keysToReset = ['/api/stats', '/api/landlords', '/api/properties', '/api/units', '/api/tenants', '/api/settings', '/api/users'];
      if (['rent', 'expense', 'invoice', 'receipt'].includes(sf)) keysToReset.push(`/api/${sf}`);
      CACHE.bust(keysToReset);
      
      closeModal();
      await loadAllData();

      if(sf==='property'&&!editingId){
        showPrompt('Add Units Now?',`"${sp.name}" created. Add all its units in bulk now?`,()=>{
          openModal('bulk_unit');
          setTimeout(()=>{const s=document.getElementById('f_property');if(s)s.value=sid;},80);
        });
      }
      if(sf==='rent'){
        const t=tenants.find(x=>tn.id(x)===sp.tenantId)||{};
        const u=units.find(x=>un.id(x)===sp.unitId)||{};
        const rcpRes=await fetch('/api/receipts/v2',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({rentId:sid,tenantName:tn.name(t),unitNumber:un.num(u),amount:sp.amount,expectedAmount:sp.expectedAmount,month:sp.month,year:sp.year,paymentMethod:sp.paymentMethod,paymentType:data.isPartial?'Partial':'Full',balanceCarried:data.balanceAfter||0})});
        const rcpData=await rcpRes.json();
        if(rcpData.success){
          await loadPage('receipts',1);
          showPrompt('View Receipt?','Payment recorded. Open the receipt now?',()=>window.open(`/api/receipts/${rcpData.id}/pdf`,'_blank'));
        }
      }
      if(sf==='user'){allUsers=await fetch('/api/users',{credentials:'include'}).then(r=>r.json());renderUsers();}
    } else {
      const errMsg=data.error||'Failed to save';
      console.error('Save error:',data);
      showToast(errMsg,'error');
    }
  }catch(e){
    console.error('Save exception:',e);
    showToast('Error: '+e.message,'error');
  }
  btn.textContent='Save'; btn.disabled=false;
}

// ── Tenant POST — extend to include new fields ───────────────────────────────
// server.js handles these via the existing PUT/POST but we also need to update
// the server to accept emergencyName etc. That's handled in server_v2_additions.js
// via the existing tenant endpoints which now have the columns in PostgreSQL.

// ── Edit functions ────────────────────────────────────────────────────────────
function editLandlord(id){
  const l=landlords.find(x=>ll.id(x)===id); if(!l) return;
  openModal('landlord'); editingId=id;
  document.getElementById('modalTitle').textContent='Edit Landlord';
  setTimeout(()=>{
    document.getElementById('f_name').value=ll.name(l);
    document.getElementById('f_phone').value=ll.phone(l);
    document.getElementById('f_email').value=ll.email(l);
    document.getElementById('f_address').value=ll.addr(l);
    document.getElementById('f_bank').value=ll.bank(l);
    document.getElementById('f_account').value=ll.acct(l);
    document.getElementById('f_commission').value=ll.comm(l);
  },60);
}
function editProperty(id){
  const p=properties.find(x=>pr.id(x)===id); if(!p) return;
  openModal('property'); editingId=id;
  document.getElementById('modalTitle').textContent='Edit Property';
  setTimeout(()=>{
    document.getElementById('f_name').value=pr.name(p);
    document.getElementById('f_landlord').value=pr.llid(p);
    document.getElementById('f_address').value=pr.addr(p);
    document.getElementById('f_type').value=pr.type(p);
  },60);
}
function editUnit(id){
  const u=units.find(x=>un.id(x)===id); if(!u) return;
  openModal('unit'); editingId=id;
  document.getElementById('modalTitle').textContent='Edit Unit';
  setTimeout(()=>{
    document.getElementById('f_property').value=un.prop(u);
    document.getElementById('f_unitno').value=un.num(u);
    document.getElementById('f_type').value=un.type(u);
    document.getElementById('f_rent').value=un.rent(u);
    document.getElementById('f_desc').value=un.desc(u);
  },60);
}
function editTenant(id){
  const t=tenants.find(x=>tn.id(x)===id); if(!t) return;
  openModal('tenant'); editingId=id;
  document.getElementById('modalTitle').textContent='Edit Tenant';
  setTimeout(()=>{
    document.getElementById('f_name').value=tn.name(t);
    document.getElementById('f_phone').value=tn.phone(t);
    document.getElementById('f_email').value=tn.email(t);
    document.getElementById('f_idno').value=tn.idno(t);
    document.getElementById('f_start').value=tn.start(t);
    document.getElementById('f_end').value=tn.end(t);
    document.getElementById('f_rent').value=tn.rent(t);
    document.getElementById('f_deposit').value=tn.deposit(t);
    // Emergency & kin
    if(document.getElementById('f_emname')) document.getElementById('f_emname').value=t['emergency_name']||t.EmergencyName||'';
    if(document.getElementById('f_emphone')) document.getElementById('f_emphone').value=t['emergency_phone']||t.EmergencyPhone||'';
    if(document.getElementById('f_nokin')) document.getElementById('f_nokin').value=t['next_of_kin_name']||t.NextOfKinName||'';
    if(document.getElementById('f_nokinphone')) document.getElementById('f_nokinphone').value=t['next_of_kin_phone']||t.NextOfKinPhone||'';
    if(document.getElementById('f_nokinrel')) document.getElementById('f_nokinrel').value=t['next_of_kin_rel']||t.NextOfKinRel||'';
    // All units for edit
    const sel=document.getElementById('f_unit');
    if(sel) sel.innerHTML='<option value="">— Select unit —</option>'+units.map(u=>{const p=properties.find(x=>pr.id(x)===un.prop(u))||{};return `<option value="${un.id(u)}" ${un.id(u)===tn.unit(t)?'selected':''}>${un.num(u)} – ${pr.name(p)} (${un.status(u)})</option>`;}).join('');
  },60);
}
function editExpense(id){
  fetch('/api/expenses?page=1&limit=200',{credentials:'include'}).then(r=>r.json()).then(res=>{
    const rows=Array.isArray(res)?res:(res.data||[]);
    const e=rows.find(x=>ex.id(x)===id); if(!e) return;
    openModal('expense'); editingId=id;
    document.getElementById('modalTitle').textContent='Edit Expense';
    setTimeout(()=>{
      document.getElementById('f_property').value=ex.prop(e);
      document.getElementById('f_category').value=ex.cat(e);
      document.getElementById('f_desc').value=ex.desc(e);
      document.getElementById('f_amount').value=ex.amt(e);
      document.getElementById('f_date').value=ex.date(e);
    },60);
  });
}
function editUser(id){
  const u=allUsers.find(x=>x.ID===id); if(!u) return;
  openModal('user'); editingId=id;
  document.getElementById('modalTitle').textContent='Edit User';
  setTimeout(()=>{
    document.getElementById('f_name').value=u.Name||'';
    const usel=document.getElementById('f_username');
    if(usel){usel.value=u.Username||'';usel.readOnly=true;usel.style.background='rgba(33,147,119,0.05)';}
    document.getElementById('f_email').value=u.Email||'';
    document.getElementById('f_role').value=u.Role||'User';
    ['f_password','f_password2'].forEach(fid=>{const el=document.getElementById(fid);if(el)el.closest('.form-group').style.display='none';});
  },60);
}

// ── Rent increase ─────────────────────────────────────────────────────────────
function openRentIncreaseModal(unitId){
  const u=units.find(x=>un.id(x)===unitId);
  const t=tenants.find(x=>tn.unit(x)===unitId&&isActive(x));
  currentForm='rent_increase'; editingId=unitId;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalBox').className='modal';
  document.getElementById('modalTitle').textContent='Rent Increase';
  document.getElementById('modalBody').innerHTML=`<div class="form-grid">
    <div class="form-group full"><label>Unit</label><input value="${u?un.num(u):unitId}" readonly style="background:rgba(33,147,119,0.05)"></div>
    <div class="form-group full"><label>Current Tenant</label><input value="${t?tn.name(t):'No active tenant'}" readonly style="background:rgba(33,147,119,0.05)"></div>
    <div class="form-group"><label>Current Rent (UGX)</label><input value="${fmtUGX(u?un.rent(u):0)}" readonly style="background:rgba(33,147,119,0.05)"></div>
    <div class="form-group"><label>New Monthly Rent (UGX) *</label><input id="f_newrent" type="number" required placeholder="Enter new amount"></div>
    <div class="form-group"><label>Effective Date *</label><input id="f_effdate" type="date" value="${new Date().toISOString().split('T')[0]}" required></div>
    <div class="form-group full"><label>Notes / Reason</label><textarea id="f_notes" placeholder="e.g. Annual review — 10% increase"></textarea></div>
  </div>`;
}

// ── Reports ───────────────────────────────────────────────────────────────────
function openReportModal(type, prefillTenantId=''){
  currentForm='report_'+type; editingId=null;
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalBox').className='modal';
  document.getElementById('modalSave').style.display='block';
  const now=new Date();
  const firstDay=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const today=now.toISOString().split('T')[0];
  const llOpts=landlords.filter(isActive).map(l=>`<option value="${ll.id(l)}">${ll.name(l)}</option>`).join('');
  const tnAllOpts=tenants.map(t=>`<option value="${tn.id(t)}" ${tn.id(t)===prefillTenantId?'selected':''}>${tn.name(t)} — ${tn.unum(t)||tn.unit(t)}</option>`).join('');
  const saveBtn=document.getElementById('modalSave');
 
  if(type==='portfolio'){
    document.getElementById('modalTitle').textContent='📊 Portfolio Report';
    document.getElementById('modalBody').innerHTML=`<div class="form-grid">
      <div class="form-group"><label>From Date *</label><input id="r_from" type="date" value="${firstDay}"></div>
      <div class="form-group"><label>To Date *</label><input id="r_to" type="date" value="${today}"></div>
    </div><p style="color:var(--text-light);font-size:12px;margin-top:12px">Full portfolio summary — all properties, rent, expenses, occupancy and arrears.</p>`;
    saveBtn.textContent='Generate Report';
    saveBtn.onclick=()=>{
      const from=document.getElementById('r_from')?.value;
      const to=document.getElementById('r_to')?.value;
      if(!from||!to){showToast('Please select a date range','error');return;}
      window.open(`/api/reports/portfolio/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    };
  } else if(type==='landlord'){
    document.getElementById('modalTitle').textContent='👤 Landlord Report';
    document.getElementById('modalBody').innerHTML=`<div class="form-grid">
      <div class="form-group full"><label>Landlord *</label><select id="r_landlord"><option value="">— Select landlord —</option>${llOpts}</select></div>
      <div class="form-group"><label>From Date *</label><input id="r_from" type="date" value="${firstDay}"></div>
      <div class="form-group"><label>To Date *</label><input id="r_to" type="date" value="${today}"></div>
    </div><p style="color:var(--text-light);font-size:12px;margin-top:12px">Includes rent collected, management fee, expenses, arrears and net disbursement.</p>`;
    saveBtn.textContent='Generate Report';
    saveBtn.onclick=()=>{
      const from=document.getElementById('r_from')?.value;
      const to=document.getElementById('r_to')?.value;
      const lid=document.getElementById('r_landlord')?.value;
      if(!from||!to){showToast('Please select a date range','error');return;}
      if(!lid){showToast('Please select a landlord','error');return;}
      window.open(`/api/reports/landlord/${lid}/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    };
  } else if(type==='tenant'){
    document.getElementById('modalTitle').textContent='👥 Tenant Statement';
    document.getElementById('modalBody').innerHTML=`<div class="form-grid">
      <div class="form-group full"><label>Tenant *</label><select id="r_tenant"><option value="">— Select tenant —</option>${tnAllOpts}</select></div>
      <div class="form-group"><label>From Date *</label><input id="r_from" type="date" value="${firstDay}"></div>
      <div class="form-group"><label>To Date *</label><input id="r_to" type="date" value="${today}"></div>
    </div><p style="color:var(--text-light);font-size:12px;margin-top:12px">Payment history, balance and lease details for the selected tenant.</p>`;
    saveBtn.textContent='Generate Statement';
    saveBtn.onclick=()=>{
      const from=document.getElementById('r_from')?.value;
      const to=document.getElementById('r_to')?.value;
      const tid=document.getElementById('r_tenant')?.value;
      if(!from||!to){showToast('Please select a date range','error');return;}
      if(!tid){showToast('Please select a tenant','error');return;}
      window.open(`/api/reports/tenant/${tid}/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    };
    if(prefillTenantId) setTimeout(()=>{const s=document.getElementById('r_tenant');if(s)s.value=prefillTenantId;},60);
  }

  // Override save button for reports
  document.getElementById('modalSave').onclick=async()=>{
    const from=gv('r_from')||document.getElementById('r_from')?.value;
    const to=gv('r_to')||document.getElementById('r_to')?.value;
    if(!from||!to){showToast('Please select a date range','error');return;}
    if(type==='portfolio'){
      window.open(`/api/reports/portfolio/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    } else if(type==='landlord'){
      const lid=document.getElementById('r_landlord')?.value;
      if(!lid){showToast('Please select a landlord','error');return;}
      window.open(`/api/reports/landlord/${lid}/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    } else if(type==='tenant'){
      const tid=document.getElementById('r_tenant')?.value;
      if(!tid){showToast('Please select a tenant','error');return;}
      window.open(`/api/reports/tenant/${tid}/pdf?from=${from}&to=${to}`,'_blank');
      closeModal();
    }
  };
}

// ── Generate receipt and view ─────────────────────────────────────────────────
async function generateAndViewReceipt(rentId){
  const r=rentData.find(x=>rn.id(x)===rentId); if(!r){showToast('Rent record not found','error');return;}
  // Check if receipt already exists for this rent ID
  const existingRes=await fetch(`/api/receipts?page=1&limit=200`,{credentials:'include'}).then(r=>r.json());
  const existingRows=Array.isArray(existingRes)?existingRes:(existingRes.data||[]);
  const existing=existingRows.find(x=>(x['Rent ID']||x.rent_id)===rentId);
  if(existing){window.open(`/api/receipts/${rc.id(existing)}/pdf`,'_blank');return;}
  // Generate new receipt
  const t=tenants.find(x=>tn.id(x)===rn.tenant(r))||{};
  const u=units.find(x=>un.id(x)===rn.unit(r))||{};
  const res=await fetch('/api/receipts/v2',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({rentId,tenantName:tn.name(t),unitNumber:un.num(u),amount:rn.amt(r),month:rn.month(r),year:rn.year(r),paymentMethod:rn.method(r),paymentType:rn.ptype(r)})});
  const data=await res.json();
  if(data.success){showToast('Receipt generated!','success');await loadPage('receipts',1);window.open(`/api/receipts/${data.id}/pdf`,'_blank');}
  else showToast(data.error||'Failed','error');
}

// ── WhatsApp message ──────────────────────────────────────────────────────────
async function generateWhatsApp(receiptId){
  try{
    const res=await fetch('/api/rent/whatsapp-message',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({receiptId})});
    const data=await res.json();
    if(!data.success){showToast(data.error||'Failed','error');return;}
    document.getElementById('promptTitle').textContent='📱 WhatsApp Message';
    document.getElementById('promptMessage').innerHTML=`<textarea id="waMsg" style="width:100%;height:180px;padding:12px;border:1px solid rgba(1,1,1,0.12);border-radius:14px;font-size:13px;font-family:monospace;resize:vertical">${data.message}</textarea><small style="color:#525252;display:block;margin-top:10px">Copy this message and send it to the tenant via WhatsApp.</small>`;
    document.getElementById('promptYes').textContent='📋 Copy';
    document.getElementById('promptYes').onclick=()=>{
      const el=document.getElementById('waMsg'); el.select(); document.execCommand('copy');
      showToast('Copied to clipboard!','success'); closePrompt();
    };
    document.getElementById('promptOverlay').classList.add('active');
  }catch(e){showToast('Error: '+e.message,'error');}
}

// ── Invoice pay ───────────────────────────────────────────────────────────────
async function payInvoice(id){
  await fetch('/api/invoices/'+id+'/pay',{method:'PUT',credentials:'include'});
  showToast('Invoice marked as paid','success');
  loadPage('invoices',pgState.invoices.page);
}

// ── Confirm delete with 30-second undo ───────────────────────────────────────
function confirmDelete(type,id,label){
  const typeLabels={tenant:'Tenant',landlord:'Landlord'};
  showPrompt(`Delete ${typeLabels[type]||type}?`,
    `"${label}" will be permanently deleted. The record will be stored in the archive.\n\nThis cannot be undone after 30 seconds.`,
    ()=>executeDelete(type,id,label),
    true // danger style
  );
}
async function executeDelete(type,id,label){
  const endpoint=type==='tenant'?`/api/tenants/${id}`:`/api/landlords/${id}`;
  try{
    const res=await fetch(endpoint,{method:'DELETE',credentials:'include'});
    const data=await res.json();
    if(data.success){
      showUndoBar(`${label} deleted`,()=>showToast('Undo not available — record is archived','info'));
      await loadAllData();
    } else { showToast(data.error||'Failed to delete','error'); }
  }catch(e){showToast('Error: '+e.message,'error');}
}

// ── User management ───────────────────────────────────────────────────────────
function setPassword(userId,userName){
  document.getElementById('promptTitle').textContent=`Set Password — ${userName}`;
  document.getElementById('promptMessage').innerHTML=`
    <input id="newPwd" type="password" placeholder="New password (min 6 chars)" style="width:100%;padding:12px;border:1px solid rgba(1,1,1,0.12);border-radius:14px;font-size:13px;margin-bottom:10px">
    <input id="newPwd2" type="password" placeholder="Confirm password" style="width:100%;padding:12px;border:1px solid rgba(1,1,1,0.12);border-radius:14px;font-size:13px">`;
  document.getElementById('promptYes').textContent='Set Password';
  document.getElementById('promptYes').onclick=async()=>{
    const p1=document.getElementById('newPwd')?.value||'';
    const p2=document.getElementById('newPwd2')?.value||'';
    if(p1.length<6){showToast('Password must be at least 6 characters','error');return;}
    if(p1!==p2){showToast('Passwords do not match','error');return;}
    closePrompt();
    const res=await fetch(`/api/users/${userId}/password`,{method:'PUT',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({password:p1})});
    const d=await res.json();
    if(d.success) showToast('Password updated!','success');
    else showToast(d.error||'Failed','error');
  };
  document.getElementById('promptOverlay').classList.add('active');
}
function deactivateUser(id,name){
  showPrompt('Deactivate User?',`Deactivate "${name}"? They will no longer be able to log in.`,async()=>{
    const res=await fetch(`/api/users/${id}`,{method:'DELETE',credentials:'include'});
    const d=await res.json();
    if(d.success){showToast('User deactivated','success');allUsers=await fetch('/api/users',{credentials:'include'}).then(r=>r.json());renderUsers();}
    else showToast(d.error||'Failed','error');
  });
}

// ── Prompt / Confirm ──────────────────────────────────────────────────────────
function showPrompt(title,msg,onYes,danger=false){
  document.getElementById('promptTitle').textContent=title;
  document.getElementById('promptMessage').textContent=msg;
  const yBtn=document.getElementById('promptYes');
  yBtn.textContent='Yes'; yBtn.className=danger?'btn-yes danger':'btn-yes';
  yBtn.onclick=()=>{closePrompt();onYes();};
  document.getElementById('promptOverlay').classList.add('active');
}
function closePrompt(){document.getElementById('promptOverlay').classList.remove('active');}

// ── Undo bar ──────────────────────────────────────────────────────────────────
function showUndoBar(msg,onUndo){
  clearTimeout(undoTimer); undoAction=onUndo;
  document.getElementById('undoMsg').textContent=msg;
  const bar=document.getElementById('undoBar');
  bar.classList.add('show');
  undoTimer=setTimeout(()=>{bar.classList.remove('show');undoAction=null;},30000);
}
function triggerUndo(){
  clearTimeout(undoTimer);
  document.getElementById('undoBar').classList.remove('show');
  if(undoAction){undoAction();undoAction=null;}
}

// ── Table filter ──────────────────────────────────────────────────────────────
function filterTable(id,q){
  const lq=q.toLowerCase();
  document.querySelectorAll('#'+id+' tr').forEach(r=>{
    if(r.classList.contains('sk-row')) return;
    r.style.display=r.textContent.toLowerCase().includes(lq)?'':'none';
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg,type='success'){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast '+type+' show';
  setTimeout(()=>t.classList.remove('show'),3500);
}
async function viewLandlordPortfolio(landlordId){
  const l=landlords.find(x=>ll.id(x)===landlordId);
  document.getElementById('modalOverlay').classList.add('active');
  document.getElementById('modalBox').className='modal wide';
  document.getElementById('modalTitle').textContent=`Portfolio — ${l?ll.name(l):landlordId}`;
  document.getElementById('modalBody').innerHTML=`<div style="text-align:center;padding:30px;color:var(--text-light)">Loading portfolio…</div>`;
  document.getElementById('modalSave').style.display='none';
  try{
    const d=await fetch(`/api/landlords/${landlordId}/portfolio`,{credentials:'include'}).then(r=>r.json());
    if(d.error){document.getElementById('modalBody').innerHTML=`<p style="color:var(--danger)">${d.error}</p>`;return;}
    const s=d.summary;
    document.getElementById('modalBody').innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;margin-bottom:24px">
        <div style="background:rgba(34,197,94,0.08);border-radius:18px;padding:18px;border-left:5px solid #22c55e;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#525252;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Properties</div>
          <div style="font-size:24px;font-weight:900;color:#010101">${s.totalProperties}</div>
        </div>
        <div style="background:rgba(33,147,119,0.08);border-radius:18px;padding:18px;border-left:5px solid #219377;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#525252;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Total Units</div>
          <div style="font-size:24px;font-weight:900;color:#010101">${s.totalUnits}</div>
        </div>
        <div style="background:rgba(255,189,89,0.1);border-radius:18px;padding:18px;border-left:5px solid #ffbd59;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#525252;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Occupied</div>
          <div style="font-size:24px;font-weight:900;color:#010101">${s.totalOccupied} / ${s.totalUnits}</div>
        </div>
        <div style="background:rgba(255,189,89,0.14);border-radius:18px;padding:18px;border-left:5px solid #ffbd59;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#B76E00;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Vacant</div>
          <div style="font-size:24px;font-weight:900;color:#B76E00">${s.totalVacant}</div>
        </div>
        <div style="background:rgba(34,197,94,0.08);border-radius:18px;padding:18px;border-left:5px solid #22c55e;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#525252;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Monthly Rent Roll</div>
          <div style="font-size:16px;font-weight:900;color:#16a34a">${fmtUGX(s.monthlyRoll)}</div>
        </div>
        <div style="background:rgba(239,68,68,0.08);border-radius:18px;padding:18px;border-left:5px solid #ef4444;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
          <div style="font-size:11px;color:#991b1b;font-weight:700;text-transform:uppercase;letter-spacing:.16em">Arrears</div>
          <div style="font-size:16px;font-weight:900;color:#dc2626">${fmtUGX(s.totalArrears)}</div>
        </div>
      </div>
      <h3 style="font-size:14px;font-weight:900;color:#219377;text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px">Properties</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(1,1,1,0.05)">
        <thead><tr style="background:rgba(34,197,94,0.08)">
          <th style="padding:14px 16px;text-align:left;font-size:11px;text-transform:uppercase;color:#525252">Property</th>
          <th style="padding:14px 16px;text-align:left;font-size:11px;text-transform:uppercase;color:#525252">Address</th>
          <th style="padding:14px 16px;text-align:center;font-size:11px;text-transform:uppercase;color:#525252">Units</th>
          <th style="padding:14px 16px;text-align:center;font-size:11px;text-transform:uppercase;color:#525252">Occ.</th>
          <th style="padding:14px 16px;text-align:center;font-size:11px;text-transform:uppercase;color:#525252">Vacant</th>
          <th style="padding:14px 16px;text-align:right;font-size:11px;text-transform:uppercase;color:#525252">Monthly Rent</th>
        </tr></thead>
        <tbody>
          ${d.properties.map(p=>`<tr style="border-bottom:1px solid rgba(1,1,1,0.08)">
            <td style="padding:14px 16px"><strong>${p.name}</strong></td>
            <td style="padding:14px 16px;color:#525252;font-size:12px">${p.address||'—'}</td>
            <td style="padding:14px 16px;text-align:center">${p.total_units}</td>
            <td style="padding:14px 16px;text-align:center"><span style="background:rgba(34,197,94,0.12);color:#166534;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700">${p.occupied}</span></td>
            <td style="padding:14px 16px;text-align:center">${Number(p.vacant)>0?`<span style="background:rgba(255,189,89,0.16);color:#B76E00;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700">${p.vacant}</span>`:'0'}</td>
            <td style="padding:14px 16px;text-align:right;font-weight:700;color:#010101">${fmtUGX(p.monthly_rent_roll)}</td>
          </tr>`).join('')}
          <tr style="background:rgba(34,197,94,0.06);font-weight:900">
            <td colspan="5" style="padding:14px 16px">TOTAL MONTHLY RENT ROLL</td>
            <td style="padding:14px 16px;text-align:right;color:#16a34a">${fmtUGX(s.monthlyRoll)}</td>
          </tr>
        </tbody>
        <!-- Mobile cards — shown on small screens instead of table rows -->
<div class="mobile-cards" id="mcLandlords"></div>
      </table>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button onclick="openReportModal('landlord')" style="padding:11px 20px;background:var(--primary);color:#fff;border:none;border-radius:14px;font-weight:700;font-size:13px;cursor:pointer">📊 Generate Full Report</button>
      </div>`;
  }catch(e){document.getElementById('modalBody').innerHTML=`<p style="color:var(--danger)">Error: ${e.message}</p>`;}
}