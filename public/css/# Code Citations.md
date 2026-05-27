# Code Citations

## License: MIT
https://github.com/DSDmark/GoRun/blob/ab7b6b53e1894a21666f684d6625d695d775e8b5/assets/js/index.js

```
I'll help you make these UI updates. Let me first explore your dashboard structure to understand the current layout.

````javascript
// filepath: views/dashboard.ejs
// ...existing code...

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('userName').textContent=USER.name||USER.username;
  document.getElementById('userDate').textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('userTime').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  
  if(USER.role==='Admin'){
    document.getElementById('usersActionsBar').style.display='flex';
    document.getElementById('saveSettingsBtn').style.display='block';
    document.getElementById('logoRow').style.display='flex';
  } else {
    ['navAdminLabel','navUsers','navArchive','navSettings'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  }
  
  // Update
```


## License: unknown
https://github.com/MrKleiner/cinema_ds/blob/db74be677e5b02f8b104fec94c2e9e8f099af58b/cinema_ds.pwned.js

```
I'll help you make these UI updates. Let me first explore your dashboard structure to understand the current layout.

````javascript
// filepath: views/dashboard.ejs
// ...existing code...

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('userName').textContent=USER.name||USER.username;
  document.getElementById('userDate').textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('userTime').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  
  if(USER.role==='Admin'){
    document.getElementById('usersActionsBar').style.display='flex';
    document.getElementById('saveSettingsBtn').style.display='block';
    document.getElementById('logoRow').style.display='flex';
  } else {
    ['navAdminLabel','navUsers','navArchive','navSettings'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  }
  
  // Update
```


## License: unknown
https://github.com/armandoIncubeta/armando-repo/blob/e14a3779a8d6094170e52a2d78098f557f19dd29/Tails%20Interactive%20Pet%20Food%20finder/300x600/atd-main.js

```
I'll help you make these UI updates. Let me first explore your dashboard structure to understand the current layout.

````javascript
// filepath: views/dashboard.ejs
// ...existing code...

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('userName').textContent=USER.name||USER.username;
  document.getElementById('userDate').textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('userTime').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  
  if(USER.role==='Admin'){
    document.getElementById('usersActionsBar').style.display='flex';
    document.getElementById('saveSettingsBtn').style.display='block';
    document.getElementById('logoRow').style.display='flex';
  } else {
    ['navAdminLabel','navUsers','navArchive','navSettings'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display='none';});
  }
  
  // Update
```

