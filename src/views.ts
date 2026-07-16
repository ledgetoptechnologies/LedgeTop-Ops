import { escapeHtml } from "./http";
import type { ShareRecord, StaffPrincipal } from "./types";

const BRAND = {
  name: "Ledge Top Drone Services",
  logo: "https://ledgetopdroneservices.com/images/DroneLogo01.webp",
  website: "https://ledgetopdroneservices.com",
};

interface AdminHeader {
  user: StaffPrincipal;
}

function layout(title: string, content: string, script = "", admin?: AdminHeader): string {
  const publicHeader = `<nav class="public-nav"><a href="${BRAND.website}"><img src="${BRAND.logo}" alt="${BRAND.name}"></a><a href="${BRAND.website}">${BRAND.name}</a></nav>`;
  const settingsLink = admin?.user.role === "admin"
    ? '<a href="/admin/settings" data-view-link="settings">Team &amp; API</a>'
    : "";
  const adminHeader = admin ? `<nav class="admin-nav">
    <a class="admin-brand" href="/admin" data-view-link="files"><img src="${BRAND.logo}" alt=""><span>${BRAND.name}<small>Client Portal</small></span></a>
    <div class="admin-tabs"><a href="/admin" data-view-link="files">Files</a><a href="/admin/deliveries" data-view-link="deliveries">Delivery Links</a>${settingsLink}</div>
    <div class="user-chip"><span>${escapeHtml((admin.user.displayName || admin.user.email).slice(0, 1).toUpperCase())}</span><div>${escapeHtml(admin.user.displayName || admin.user.email)}<small>${escapeHtml(admin.user.role)}</small></div></div>
  </nav>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} &middot; ${BRAND.name}</title>
  <style>
    :root{--gold:#f8cb2e;--orange:#ee5007;--ink:#111820;--muted:#69737d;--paper:#fff;--wash:#f4f6f8;--line:#e4e8eb;--blue:#2869d8}
    *{box-sizing:border-box}body{margin:0;background:var(--wash);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink)}
    .public-nav{height:72px;padding:10px max(20px,calc((100vw - 1120px)/2));background:#050505;display:flex;align-items:center;justify-content:space-between;color:#fff}.public-nav img{height:52px;display:block}.public-nav a{color:var(--gold);text-decoration:none;font-weight:700}
    main{width:min(1120px,calc(100% - 32px));margin:38px auto 72px}.admin-main{width:min(1320px,calc(100% - 36px));margin:28px auto 72px}
    .admin-nav{min-height:74px;padding:0 max(18px,calc((100vw - 1320px)/2));background:#080808;color:#fff;display:flex;align-items:center;gap:28px;box-shadow:0 1px 0 #222;position:sticky;top:0;z-index:20}.admin-brand{display:flex;align-items:center;gap:11px;color:#fff;text-decoration:none;font-weight:750;line-height:1.1;white-space:nowrap}.admin-brand img{height:47px}.admin-brand small{display:block;color:var(--gold);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-top:4px}.admin-tabs{align-self:stretch;display:flex;align-items:stretch;gap:4px}.admin-tabs a{display:flex;align-items:center;color:#c8cdd2;text-decoration:none;font-weight:650;padding:0 15px;border-bottom:3px solid transparent}.admin-tabs a:hover{color:#fff}.admin-tabs a.active{color:var(--gold);border-bottom-color:var(--gold)}
    .user-chip{margin-left:auto;display:flex;align-items:center;gap:9px;color:#fff;font-size:.86rem;line-height:1.2}.user-chip>span{width:35px;height:35px;border-radius:50%;display:grid;place-items:center;background:var(--gold);color:#111;font-weight:850}.user-chip small{display:block;color:#9098a0;text-transform:capitalize;margin-top:3px}
    .card{background:var(--paper);border:1px solid #e9ecef;border-radius:13px;box-shadow:0 5px 22px #15202b0b;padding:25px;margin-bottom:20px}.view-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:21px}.view-heading h1{margin:0 0 5px;font-size:1.75rem}.view-heading p{margin:0;color:var(--muted)}
    h1,h2,h3{line-height:1.18;margin:0 0 12px}h1{font-size:clamp(1.8rem,4vw,2.6rem)}h2{font-size:1.18rem}h3{font-size:1rem}.muted{color:var(--muted)}.eyebrow{color:var(--orange);font-size:.75rem;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.two-column{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:20px}
    label{display:block;font-size:.82rem;font-weight:750;margin:12px 0 5px}input,select{width:100%;padding:10px 12px;border:1px solid #cbd2d8;border-radius:7px;font:inherit;background:#fff}input:focus,select:focus{outline:3px solid #2869d820;border-color:var(--blue)}input[type=checkbox]{width:auto;margin-right:7px}
    button,.button{border:0;border-radius:7px;background:var(--orange);color:#fff;padding:9px 15px;font:inherit;font-weight:720;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:7px}button:hover,.button:hover{filter:brightness(.96)}button.secondary,.button.secondary{background:#111;color:var(--gold)}button.ghost,.button.ghost{background:#eef1f3;color:#26313a}button.danger{background:#a72b37}button:disabled{opacity:.45;cursor:not-allowed}.small-button{padding:6px 10px;font-size:.82rem}
    table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:800}tbody tr:last-child td{border-bottom:0}.table-wrap{overflow:auto}
    .notice{padding:12px 14px;border-radius:7px;background:#fff5cf;border-left:4px solid var(--gold);margin:16px 0}.notice.error{background:#fff0f1;border-left-color:#b12635}.notice.success{background:#edf9f1;border-left-color:#279555}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.landing-actions{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-top:30px}.right{margin-left:auto}code{background:#eef1f3;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}
    .explorer{padding:0;overflow:hidden}.explorer-toolbar{min-height:61px;padding:11px 15px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px;flex-wrap:wrap}.breadcrumbs{display:flex;align-items:center;gap:3px;min-width:0;flex:1}.crumb{background:transparent;color:#34404a;padding:6px 7px;font-weight:650}.crumb:hover{background:#eef1f3}.crumb-separator{color:#a1a8ae}.file-table th:first-child,.file-table td:first-child{padding-left:18px}.file-table th:last-child,.file-table td:last-child{padding-right:18px}.file-row:hover{background:#f8fafb}.file-entry{display:flex;align-items:center;gap:12px;min-width:250px}.file-entry button,.file-entry a{padding:0;background:transparent;color:#17212a;font-weight:650;text-decoration:none;text-align:left}.file-entry button:hover,.file-entry a:hover{color:var(--blue);filter:none}.file-icon{width:35px;height:35px;border-radius:7px;background:#e9edf0;color:#63707b;display:grid;place-items:center;font-size:.64rem;font-weight:900;letter-spacing:.02em;flex:0 0 auto}.file-icon.folder{background:#fff1ad;color:#8a6500;position:relative}.file-icon.folder:before{content:"";position:absolute;left:5px;top:-3px;width:15px;height:7px;border-radius:3px 3px 0 0;background:#f2cb39}.file-meta-mobile{display:none}.explorer-empty{padding:52px 20px;text-align:center;color:var(--muted)}.explorer-footer{padding:12px 16px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;color:var(--muted)}
    .stat-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}.stat{background:#f7f9fa;border:1px solid var(--line);border-radius:9px;padding:14px}.stat strong{display:block;font-size:1.35rem}.stat span{color:var(--muted);font-size:.82rem}.status-pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#edf9f1;color:#197344;font-size:.73rem;font-weight:800}.status-pill.revoked{background:#f4e9eb;color:#9e2835}.section-note{background:#f6f8fa;border-radius:8px;padding:13px;color:var(--muted);font-size:.88rem}
    .admin-view[hidden]{display:none}.loading{color:var(--muted);padding:24px;text-align:center}.copy-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.copy-line code{flex:1;min-width:220px;padding:8px}.files{list-style:none;padding:0;margin:0}.file{display:flex;gap:16px;align-items:center;padding:15px 0;border-bottom:1px solid var(--line)}.file:last-child{border:0}.file-info{min-width:0;flex:1}.file-name{font-weight:700;overflow-wrap:anywhere}
    @media(max-width:850px){.admin-nav{gap:10px;flex-wrap:wrap;padding:8px 14px}.admin-tabs{order:3;width:100%;height:44px;overflow:auto}.admin-tabs a{padding:0 12px}.user-chip div{display:none}.two-column{grid-template-columns:1fr}.stat-row{grid-template-columns:1fr}.admin-main{margin-top:18px}.view-heading{flex-direction:column}.file-table th:nth-child(2),.file-table td:nth-child(2){display:none}}
    @media(max-width:600px){main{margin-top:20px}.card{padding:18px}.admin-brand span{display:none}.file-table th:nth-child(3),.file-table td:nth-child(3){display:none}.explorer-toolbar{align-items:flex-start}.breadcrumbs{width:100%;order:3}.file-meta-mobile{display:block;font-size:.75rem;color:var(--muted);font-weight:400;margin-top:2px}}
  </style>
</head>
<body class="${admin ? "admin-body" : ""}">
  ${admin ? adminHeader : publicHeader}
  <main class="${admin ? "admin-main" : ""}">${content}</main>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

export function renderLanding(): string {
  return layout("Secure client delivery", `<section class="card">
    <div class="eyebrow">Secure delivery portal</div>
    <h1>Your project files, delivered simply.</h1>
    <p class="muted">Open the private link supplied by Ledge Top Drone Services to view and download your files.</p>
    <div class="landing-actions"><a class="button" href="/admin">Staff sign in</a><a class="button secondary" href="${BRAND.website}">Visit our website</a></div>
  </section>`);
}

export function renderError(title: string, message: string, status: number): string {
  return layout(title, `<section class="card"><div class="eyebrow">${status}</div><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p></section>`);
}

export function renderUnlock(share: ShareRecord, token: string, invalid = false): string {
  return layout("Access code required", `<section class="card" style="max-width:560px;margin-inline:auto">
    <div class="eyebrow">Protected delivery</div><h1>${escapeHtml(share.project_name)}</h1>
    <p class="muted">Enter the access code supplied separately for ${escapeHtml(share.client_name)}.</p>
    ${invalid ? '<div class="notice error">That access code was not accepted.</div>' : ""}
    <form method="post" action="/s/${encodeURIComponent(token)}/unlock">
      <label for="access_code">Access code</label><input id="access_code" name="access_code" type="password" required autocomplete="one-time-code" autofocus>
      <p><button type="submit">Open project</button></p>
    </form>
  </section>`);
}

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function renderPortal(share: ShareRecord, token: string, objects: R2Object[], nextCursor?: string): string {
  const files = objects.filter((object) => object.size > 0 && !object.key.endsWith("/")).map((object) => {
    const relative = object.key.slice(share.r2_prefix.length);
    const url = `/s/${encodeURIComponent(token)}/download?key=${encodeURIComponent(object.key)}`;
    return `<li class="file"><div class="file-info"><div class="file-name">${escapeHtml(relative)}</div><div class="muted">${formatSize(object.size)}</div></div><a class="button" href="${url}">Download</a></li>`;
  }).join("");
  const next = nextCursor ? `<a class="button secondary" href="/s/${encodeURIComponent(token)}?cursor=${encodeURIComponent(nextCursor)}">More files</a>` : "";
  return layout(share.project_name, `<section class="card"><div class="eyebrow">Client delivery</div><h1>${escapeHtml(share.project_name)}</h1><p class="muted">Prepared for <strong>${escapeHtml(share.client_name)}</strong></p></section>
  <section class="card"><h2>Available files</h2>${files ? `<ul class="files">${files}</ul>${next}` : '<div class="notice">Files are still being prepared. Please check this link again shortly.</div>'}</section>`);
}

export function renderAdmin(user: StaffPrincipal): string {
  const settingsView = user.role === "admin" ? `<section class="admin-view" data-view="settings" hidden>
    <div class="view-heading"><div><h1>Team &amp; API</h1><p>Manage staff authorization and server-to-server access.</p></div></div>
    <div class="two-column">
      <div>
        <section class="card"><h2>Staff accounts</h2><p class="muted">Cloudflare Access handles sign-in; this list controls roles inside the portal.</p><div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Last seen</th></tr></thead><tbody id="staff-list"><tr><td colspan="3" class="loading">Loading staff…</td></tr></tbody></table></div></section>
        <section class="card"><h2>Add staff member</h2><form id="staff-form"><div class="grid"><div><label>Email</label><input name="email" type="email" required></div><div><label>Display name</label><input name="display_name"></div><div><label>Role</label><select name="role"><option value="staff">Staff</option><option value="admin">Administrator</option></select></div></div><p><button>Add staff account</button></p></form></section>
      </div>
      <div>
        <section class="card"><h2>Integration keys</h2><p class="muted">Keys let Project Alpha create delivery links without R2 credentials.</p><div id="key-result"></div><form id="key-form"><label>Integration name</label><input name="name" value="Project Alpha" required><label>Scopes</label><input name="scopes" value="shares:write shares:read" required><p><button>Create API key</button></p></form><div class="table-wrap"><table><thead><tr><th>Key</th><th>Scopes</th><th>Last used</th></tr></thead><tbody id="key-list"><tr><td colspan="3" class="loading">Loading keys…</td></tr></tbody></table></div></section>
        <div class="section-note">Raw API keys are displayed once. Store them in the receiving application's secret manager, never in client-side code.</div>
      </div>
    </div>
  </section>` : "";

  const content = `<section class="admin-view" data-view="files">
    <div class="view-heading"><div><h1>Files</h1><p>Browse the private R2 bucket using the same folder structure synced from TrueNAS.</p></div><div class="actions"><button class="ghost" id="refresh-files">Refresh</button><button id="create-from-folder" disabled>Create delivery from folder</button></div></div>
    <section class="card explorer">
      <div class="explorer-toolbar"><button class="ghost small-button" id="up-folder" disabled>Up</button><div class="breadcrumbs" id="breadcrumbs"></div></div>
      <div class="table-wrap"><table class="file-table"><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody id="file-rows"><tr><td colspan="4" class="loading">Loading files…</td></tr></tbody></table></div>
      <div class="explorer-footer"><span id="file-status">Loading…</span><button class="ghost small-button" id="load-more-files" hidden>Load more</button></div>
    </section>
    <div class="section-note">This view is intentionally read-only. TrueNAS remains the source of truth, so folder moves and deletions should happen there before the next R2 sync.</div>
  </section>

  <section class="admin-view" data-view="deliveries" hidden>
    <div class="view-heading"><div><h1>Delivery Links</h1><p>Create, review, and revoke secure client access.</p></div></div>
    <div class="stat-row"><div class="stat"><strong id="active-share-count">—</strong><span>Active links</span></div><div class="stat"><strong id="protected-share-count">—</strong><span>Access-code protected</span></div><div class="stat"><strong id="delivery-count">—</strong><span>Total deliveries</span></div></div>
    <section class="card"><h2>Create delivery link</h2><form id="share-form"><div class="grid">
      <div><label>Client name</label><input name="client_name" required></div><div><label>Project name</label><input name="project_name" required></div>
      <div><label>R2 folder prefix</label><input name="r2_prefix" placeholder="clients/acme/roof-july/" required></div><div><label>Project Alpha reference (optional)</label><input name="external_ref"></div>
      <div><label>Access code (optional, 8+ characters)</label><input name="password" type="password"><label><input name="generate_access_code" type="checkbox" value="true">Generate a secure code instead</label></div><div><label>Expiration (optional)</label><input name="expires_at" type="datetime-local"></div>
    </div><p><button>Create delivery link</button></p></form><div id="share-result"></div></section>
    <section class="card"><div class="actions"><h2>Recent links</h2><button class="ghost right" id="refresh-shares">Refresh</button></div><div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Folder</th><th>Security</th><th>Created</th><th></th></tr></thead><tbody id="shares"><tr><td colspan="5" class="loading">Loading links…</td></tr></tbody></table></div></section>
  </section>${settingsView}`;

  return layout("Client Portal", content, `const api='/api/v1/admin';
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const formatSize=(n)=>{if(!n)return '0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),u.length-1);return (n/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i]};
const formatDate=(v)=>{if(!v)return 'Never';const raw=String(v);const d=new Date(raw.includes('T')?raw:raw.replace(' ','T')+'Z');return Number.isNaN(d.getTime())?raw:d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'})};
async function call(path,options={}){const headers={...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})};const r=await fetch(api+path,{...options,headers});const text=await r.text();let b={};try{b=text?JSON.parse(text):{}}catch{b={error:text||'Request failed'}}if(!r.ok)throw new Error(b.error||'Request failed');return b}
function viewForPath(){if(location.pathname.includes('/deliveries'))return 'deliveries';if(location.pathname.includes('/settings'))return 'settings';return 'files'}
function showView(name,push=true){if(!document.querySelector('[data-view="'+name+'"]'))name='files';document.querySelectorAll('.admin-view').forEach(v=>v.hidden=v.dataset.view!==name);document.querySelectorAll('[data-view-link]').forEach(a=>a.classList.toggle('active',a.dataset.viewLink===name));if(push){const paths={files:'/admin',deliveries:'/admin/deliveries',settings:'/admin/settings'};history.pushState({view:name},'',paths[name])}if(name==='files')loadFiles(currentPrefix);if(name==='deliveries')loadShares();if(name==='settings')loadSettings()}
document.querySelectorAll('[data-view-link]').forEach(a=>a.onclick=e=>{e.preventDefault();showView(a.dataset.viewLink)});window.onpopstate=()=>showView(viewForPath(),false);
let currentPrefix='';let nextFileCursor=null;
function folderParent(prefix){const p=prefix.split('/').filter(Boolean);p.pop();return p.length?p.join('/')+'/':''}
function renderBreadcrumbs(prefix){const parts=prefix.split('/').filter(Boolean);let built='';let out='<button class="crumb" data-prefix="">All files</button>';for(const part of parts){built+=part+'/';out+='<span class="crumb-separator">/</span><button class="crumb" data-prefix="'+esc(built)+'">'+esc(part)+'</button>'}document.querySelector('#breadcrumbs').innerHTML=out;document.querySelectorAll('.crumb').forEach(b=>b.onclick=()=>loadFiles(b.dataset.prefix||''))}
function fileBadge(name){const p=name.split('.');const ext=p.length>1?p.pop().slice(0,4).toUpperCase():'FILE';return esc(ext||'FILE')}
async function loadFiles(prefix='',cursor=null,append=false){currentPrefix=prefix;renderBreadcrumbs(prefix);const up=document.querySelector('#up-folder');up.disabled=!prefix;up.onclick=()=>loadFiles(folderParent(prefix));const create=document.querySelector('#create-from-folder');create.disabled=!prefix;create.title=prefix?'Create a client link for this folder':'Open a project folder first';document.querySelector('#file-status').textContent='Loading…';if(!append)document.querySelector('#file-rows').innerHTML='<tr><td colspan="4" class="loading">Loading files…</td></tr>';try{const q='?prefix='+encodeURIComponent(prefix)+(cursor?'&cursor='+encodeURIComponent(cursor):'');const b=await call('/files'+q);currentPrefix=b.prefix;renderBreadcrumbs(b.prefix);const folders=b.folders.map(f=>'<tr class="file-row"><td><div class="file-entry"><span class="file-icon folder"></span><button data-folder="'+esc(f.prefix)+'">'+esc(f.name)+'</button></div></td><td>—</td><td>—</td><td></td></tr>');const files=b.files.map(f=>'<tr class="file-row"><td><div class="file-entry"><span class="file-icon">'+fileBadge(f.name)+'</span><a href="'+api+'/files/download?key='+encodeURIComponent(f.key)+'">'+esc(f.name)+'<span class="file-meta-mobile">'+formatSize(f.size)+'</span></a></div></td><td>'+formatSize(f.size)+'</td><td>'+formatDate(f.uploaded)+'</td><td><a class="button ghost small-button" href="'+api+'/files/download?key='+encodeURIComponent(f.key)+'">Download</a></td></tr>');const rows=folders.concat(files);const tbody=document.querySelector('#file-rows');if(append)tbody.insertAdjacentHTML('beforeend',rows.join(''));else tbody.innerHTML=rows.join('')||'<tr><td colspan="4"><div class="explorer-empty">This folder is empty.</div></td></tr>';document.querySelectorAll('[data-folder]').forEach(x=>x.onclick=()=>loadFiles(x.dataset.folder));nextFileCursor=b.next_cursor;const more=document.querySelector('#load-more-files');more.hidden=!nextFileCursor;more.onclick=()=>loadFiles(currentPrefix,nextFileCursor,true);document.querySelector('#file-status').textContent=(b.folders.length+b.files.length)+' item'+((b.folders.length+b.files.length)===1?'':'s')+(b.next_cursor?' on this page':'')}catch(e){document.querySelector('#file-rows').innerHTML='<tr><td colspan="4"><div class="explorer-empty">'+esc(e.message)+'</div></td></tr>';document.querySelector('#file-status').textContent='Unable to load folder'}}
document.querySelector('#refresh-files').onclick=()=>loadFiles(currentPrefix);document.querySelector('#create-from-folder').onclick=()=>{showView('deliveries');const input=document.querySelector('#share-form [name=r2_prefix]');input.value=currentPrefix;document.querySelector('#share-form [name=client_name]').focus()};
async function loadShares(){try{const b=await call('/shares');const active=b.shares.filter(s=>!s.revoked_at);document.querySelector('#active-share-count').textContent=active.length;document.querySelector('#protected-share-count').textContent=active.filter(s=>s.password_protected).length;document.querySelector('#delivery-count').textContent=b.shares.length;document.querySelector('#shares').innerHTML=b.shares.map(s=>'<tr><td><strong>'+esc(s.client_name)+'</strong><br><span class="muted">'+esc(s.project_name)+'</span></td><td><code>'+esc(s.r2_prefix)+'</code></td><td><span class="status-pill '+(s.revoked_at?'revoked':'')+'">'+(s.revoked_at?'Revoked':(s.password_protected?'Access code':'Link only'))+'</span></td><td>'+formatDate(s.created_at)+'</td><td>'+(s.revoked_at?'':'<button class="danger small-button revoke" data-id="'+esc(s.id)+'">Revoke</button>')+'</td></tr>').join('')||'<tr><td colspan="5" class="loading">No delivery links yet.</td></tr>';document.querySelectorAll('.revoke').forEach(x=>x.onclick=async()=>{if(confirm('Revoke this delivery link?')){await call('/shares/'+x.dataset.id,{method:'DELETE'});loadShares()}})}catch(e){document.querySelector('#shares').innerHTML='<tr><td colspan="5" class="loading">'+esc(e.message)+'</td></tr>'}}
document.querySelector('#refresh-shares').onclick=loadShares;document.querySelector('#share-form').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));f.generate_access_code=f.generate_access_code==='true';if(f.expires_at)f.expires_at=new Date(f.expires_at).toISOString();try{const b=await call('/shares',{method:'POST',body:JSON.stringify(f)});const code=b.share.access_code?'<div class="copy-line"><strong>Access code</strong><code>'+esc(b.share.access_code)+'</code></div>':'';document.querySelector('#share-result').innerHTML='<div class="notice success"><strong>Delivery link created</strong><div class="copy-line"><code>'+esc(b.share.share_url)+'</code><button type="button" class="ghost small-button copy-value" data-copy="'+esc(b.share.share_url)+'">Copy</button></div>'+code+'</div>';e.target.reset();bindCopy();loadShares()}catch(x){document.querySelector('#share-result').innerHTML='<div class="notice error">'+esc(x.message)+'</div>'}};
function bindCopy(){document.querySelectorAll('.copy-value').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copy||'');b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1400)})}
let settingsLoaded=false;async function loadSettings(){if(settingsLoaded||!document.querySelector('#staff-list'))return;try{const [staff,keys]=await Promise.all([call('/staff'),call('/api-keys')]);document.querySelector('#staff-list').innerHTML=staff.staff.map(s=>'<tr><td><strong>'+esc(s.display_name||s.email)+'</strong><br><span class="muted">'+esc(s.email)+'</span></td><td>'+esc(s.role)+'</td><td>'+formatDate(s.last_seen_at)+'</td></tr>').join('');document.querySelector('#key-list').innerHTML=keys.api_keys.map(k=>'<tr><td><strong>'+esc(k.name)+'</strong><br><code>'+esc(k.key_prefix)+'…</code></td><td>'+esc(k.scopes)+'</td><td>'+formatDate(k.last_used_at)+'</td></tr>').join('')||'<tr><td colspan="3" class="loading">No integration keys.</td></tr>';settingsLoaded=true}catch(e){document.querySelector('#staff-list').innerHTML='<tr><td colspan="3" class="loading">'+esc(e.message)+'</td></tr>'}}
const staffForm=document.querySelector('#staff-form');if(staffForm)staffForm.onsubmit=async e=>{e.preventDefault();try{await call('/staff',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();settingsLoaded=false;loadSettings()}catch(x){alert(x.message)}};
const keyForm=document.querySelector('#key-form');if(keyForm)keyForm.onsubmit=async e=>{e.preventDefault();try{const b=await call('/api-keys',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});document.querySelector('#key-result').innerHTML='<div class="notice success"><strong>Copy this key now</strong><div class="copy-line"><code>'+esc(b.api_key)+'</code><button type="button" class="ghost small-button copy-value" data-copy="'+esc(b.api_key)+'">Copy</button></div></div>';bindCopy();settingsLoaded=false;loadSettings()}catch(x){document.querySelector('#key-result').innerHTML='<div class="notice error">'+esc(x.message)+'</div>'}};
showView(viewForPath(),false);`, { user });
}
