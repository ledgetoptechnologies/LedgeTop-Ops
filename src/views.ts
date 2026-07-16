import { escapeHtml } from "./http";
import type { ShareRecord, StaffPrincipal } from "./types";

const BRAND = {
  name: "Ledge Top Drone Services",
  logo: "https://ledgetopdroneservices.com/images/DroneLogo01.webp",
  website: "https://ledgetopdroneservices.com",
};

function layout(title: string, content: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · ${BRAND.name}</title>
  <style>
    :root{--gold:#f8cb2e;--orange:#ee5007;--ink:#111;--muted:#68717a;--paper:#fff;--wash:#f4f7f9}
    *{box-sizing:border-box}body{margin:0;background:var(--wash);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink)}
    nav{height:72px;padding:10px max(20px,calc((100vw - 1120px)/2));background:#050505;display:flex;align-items:center;justify-content:space-between;color:#fff}
    nav img{height:52px;display:block}nav a{color:var(--gold);text-decoration:none;font-weight:700}
    main{width:min(1120px,calc(100% - 32px));margin:38px auto 72px}.card{background:var(--paper);border-radius:14px;box-shadow:0 8px 30px #15202b12;padding:26px;margin-bottom:22px}
    h1,h2{line-height:1.15;margin:0 0 12px}h1{font-size:clamp(1.8rem,4vw,2.6rem)}h2{font-size:1.2rem}.muted{color:var(--muted)}
    .eyebrow{color:var(--orange);font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
    label{display:block;font-size:.85rem;font-weight:700;margin:12px 0 5px}input{width:100%;padding:11px 12px;border:1px solid #ccd3d8;border-radius:8px;font:inherit}input[type=checkbox]{width:auto;margin-right:7px}
    button,.button{border:0;border-radius:8px;background:var(--orange);color:#fff;padding:10px 17px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}
    button.secondary,.button.secondary{background:#111;color:var(--gold)}button.danger{background:#9c2330}button:disabled{opacity:.55;cursor:wait}
    table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px 9px;border-bottom:1px solid #e7eaed;vertical-align:top}th{font-size:.77rem;text-transform:uppercase;color:var(--muted)}
    .files{list-style:none;padding:0;margin:0}.file{display:flex;gap:16px;align-items:center;padding:15px 0;border-bottom:1px solid #e7eaed}.file:last-child{border:0}.file-info{min-width:0;flex:1}.file-name{font-weight:700;overflow-wrap:anywhere}
    .notice{padding:12px 14px;border-radius:8px;background:#fff5cf;border-left:4px solid var(--gold);margin:16px 0}.error{background:#fff0f1;border-left-color:#b12635}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.right{margin-left:auto}
    code{background:#eef1f3;padding:2px 5px;border-radius:4px}dialog{border:0;border-radius:14px;box-shadow:0 20px 70px #0006;max-width:560px;width:calc(100% - 30px)}dialog::backdrop{background:#0008}
    @media(max-width:700px){main{margin-top:22px}.card{padding:19px}table thead{display:none}table tr,table td{display:block}table tr{padding:12px 0;border-bottom:1px solid #ddd}table td{border:0;padding:3px 0}}
  </style>
</head>
<body>
  <nav><a href="${BRAND.website}"><img src="${BRAND.logo}" alt="${BRAND.name}"></a><a href="${BRAND.website}">${BRAND.name}</a></nav>
  <main>${content}</main>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

export function renderLanding(): string {
  return layout("Secure client delivery", `<section class="card">
    <div class="eyebrow">Secure delivery portal</div>
    <h1>Your project files, delivered simply.</h1>
    <p class="muted">Open the private link supplied by Ledge Top Drone Services to view and download your files.</p>
    <div class="actions"><a class="button secondary" href="${BRAND.website}">Visit our website</a><a class="button" href="/admin">Staff sign in</a></div>
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

export function renderPortal(
  share: ShareRecord,
  token: string,
  objects: R2Object[],
  nextCursor?: string,
): string {
  const files = objects.filter((object) => object.size > 0 && !object.key.endsWith("/")).map((object) => {
    const relative = object.key.slice(share.r2_prefix.length);
    const url = `/s/${encodeURIComponent(token)}/download?key=${encodeURIComponent(object.key)}`;
    return `<li class="file"><div class="file-info"><div class="file-name">${escapeHtml(relative)}</div><div class="muted">${formatSize(object.size)}</div></div><a class="button" href="${url}">Download</a></li>`;
  }).join("");
  const next = nextCursor
    ? `<a class="button secondary" href="/s/${encodeURIComponent(token)}?cursor=${encodeURIComponent(nextCursor)}">More files</a>`
    : "";
  return layout(share.project_name, `<section class="card">
    <div class="eyebrow">Client delivery</div><h1>${escapeHtml(share.project_name)}</h1>
    <p class="muted">Prepared for <strong>${escapeHtml(share.client_name)}</strong></p>
  </section><section class="card"><h2>Available files</h2>
    ${files ? `<ul class="files">${files}</ul>${next}` : '<div class="notice">Files are still being prepared. Please check this link again shortly.</div>'}
  </section>`);
}

export function renderAdmin(user: StaffPrincipal): string {
  const adminOnly = user.role === "admin" ? `<section class="card"><h2>Administration</h2><div class="grid">
    <form id="staff-form"><label>Staff email</label><input name="email" type="email" required><label>Display name</label><input name="display_name"><label>Role</label><input name="role" value="staff" pattern="admin|staff" required><p><button>Add staff account</button></p></form>
    <form id="key-form"><label>Integration name</label><input name="name" value="Project Alpha" required><label>Scopes</label><input name="scopes" value="shares:write shares:read" required><p><button>Create API key</button></p></form>
  </div></section>` : "";
  return layout("Staff dashboard", `<section class="card"><div class="eyebrow">Staff dashboard</div><h1>Client deliveries</h1><p class="muted">Signed in as ${escapeHtml(user.displayName || user.email)} · ${escapeHtml(user.role)}</p></section>
  <section class="card"><h2>Create delivery link</h2><form id="share-form"><div class="grid">
    <div><label>Client name</label><input name="client_name" required></div><div><label>Project name</label><input name="project_name" required></div>
    <div><label>R2 folder prefix</label><input name="r2_prefix" placeholder="clients/acme/roof-july/" required></div><div><label>Project Alpha reference (optional)</label><input name="external_ref"></div>
    <div><label>Access code (optional, 8+ characters)</label><input name="password" type="password"><label><input name="generate_access_code" type="checkbox" value="true">Generate a secure code instead</label></div><div><label>Expiration (optional)</label><input name="expires_at" type="datetime-local"></div>
  </div><p><button>Create link</button></p></form><div id="result"></div></section>
  <section class="card"><div class="actions"><h2>Recent delivery links</h2><button class="secondary right" id="refresh">Refresh</button></div><div style="overflow:auto"><table><thead><tr><th>Client / project</th><th>R2 prefix</th><th>Protection</th><th>Created</th><th></th></tr></thead><tbody id="shares"><tr><td colspan="5">Loading…</td></tr></tbody></table></div></section>${adminOnly}`,
  `const api='/api/v1/admin';
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
async function call(path,options={}){const r=await fetch(api+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const b=await r.json();if(!r.ok)throw new Error(b.error||'Request failed');return b}
async function load(){try{const b=await call('/shares');document.querySelector('#shares').innerHTML=b.shares.map(s=>'<tr><td><strong>'+esc(s.client_name)+'</strong><br>'+esc(s.project_name)+'</td><td><code>'+esc(s.r2_prefix)+'</code></td><td>'+(s.password_protected?'Access code':'Link only')+(s.revoked_at?'<br><strong>Revoked</strong>':'')+'</td><td>'+esc(s.created_at)+'</td><td>'+(s.revoked_at?'':'<button class="danger revoke" data-id="'+esc(s.id)+'">Revoke</button>')+'</td></tr>').join('')||'<tr><td colspan="5">No links yet.</td></tr>';document.querySelectorAll('.revoke').forEach(x=>x.onclick=async()=>{if(confirm('Revoke this link?')){await call('/shares/'+x.dataset.id,{method:'DELETE'});load()}})}catch(e){document.querySelector('#shares').innerHTML='<tr><td colspan="5">'+esc(e.message)+'</td></tr>'}}
document.querySelector('#refresh').onclick=load;document.querySelector('#share-form').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));f.generate_access_code=f.generate_access_code==='true';if(f.expires_at)f.expires_at=new Date(f.expires_at).toISOString();try{const b=await call('/shares',{method:'POST',body:JSON.stringify(f)});const code=b.share.access_code?'<br>Access code (copy now): <code>'+esc(b.share.access_code)+'</code>':'';document.querySelector('#result').innerHTML='<div class="notice"><strong>Link created</strong><br><code>'+esc(b.share.share_url)+'</code>'+code+'</div>';e.target.reset();load()}catch(x){document.querySelector('#result').innerHTML='<div class="notice error">'+esc(x.message)+'</div>'}};
const staff=document.querySelector('#staff-form');if(staff)staff.onsubmit=async e=>{e.preventDefault();try{await call('/staff',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});alert('Staff account added');e.target.reset()}catch(x){alert(x.message)}};
const key=document.querySelector('#key-form');if(key)key.onsubmit=async e=>{e.preventDefault();try{const b=await call('/api-keys',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});alert('Copy this key now; it will not be shown again:\n\n'+b.api_key)}catch(x){alert(x.message)}};load();`);
}
