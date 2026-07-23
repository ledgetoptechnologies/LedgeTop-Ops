export function requestPage(publicId: string, siteKey: string): string {
  const escapedId = JSON.stringify(publicId);
  const escapedSiteKey = siteKey.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send files to Ledge Top Drone Services</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172033;background:#f3f6f9}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.panel{width:min(720px,100%);background:white;border:1px solid #dbe3ea;border-radius:18px;box-shadow:0 18px 55px #25354d18;padding:28px}
h1{margin:0 0 8px;font-size:clamp(1.65rem,4vw,2.25rem)}p{color:#5b6878;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:6px;margin:14px 0}
label{font-weight:650}input,textarea{width:100%;border:1px solid #b9c5d2;border-radius:10px;padding:12px;font:inherit}textarea{min-height:90px}
.drop{border:2px dashed #9cb4cc;border-radius:14px;padding:28px;text-align:center;background:#f8fafc}.drop input{border:0;padding:0}
button{border:0;border-radius:10px;background:#125a88;color:white;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}
.status{margin-top:16px;display:grid;gap:8px}.file{background:#eef3f7;border-radius:10px;padding:10px}.bar{height:6px;background:#dbe3ea;border-radius:999px;overflow:hidden}.bar span{display:block;height:100%;background:#1683ba;transition:width .2s}
.hidden{display:none}.notice{padding:12px;border-radius:10px;background:#edf7ed;color:#245b2b}.error{background:#fff0f0;color:#8c2424}@media(max-width:580px){.grid{grid-template-columns:1fr}.panel{padding:20px}}
</style>
${siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
</head><body><main class="panel">
<h1>Send files securely</h1><p>Files go into a private quarantine area for Ledge Top Drone Services. They are scanned before being moved into production.</p>
<section id="identity"><div class="grid"><div class="field"><label for="name">Your name</label><input id="name" maxlength="120" autocomplete="name" required></div><div class="field"><label for="email">Email</label><input id="email" type="email" maxlength="254" autocomplete="email" required></div></div>
<div class="field"><label for="message">Message (optional)</label><textarea id="message" maxlength="2000"></textarea></div>
<div class="field"><label for="code">Access code (if provided)</label><input id="code" type="password" maxlength="128"></div>
${siteKey ? `<div class="cf-turnstile" data-sitekey="${escapedSiteKey}" data-action="turnstile-spin-v2"></div>` : ""}
<button id="continue">Continue</button></section>
<section id="upload" class="hidden"><div class="drop"><label for="files">Choose files</label><p>Up to 500 files. Large files upload in 32 MiB parts.</p><input id="files" type="file" multiple></div><button id="send" disabled>Upload files</button></section>
<div id="status" class="status" aria-live="polite"></div>
</main><script>
const requestId=${escapedId}, partSize=32*1024*1024, status=document.querySelector("#status");
const api=async(path,body)=>{const response=await fetch("/api/public/requests/"+encodeURIComponent(requestId)+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await response.json().catch(()=>({message:"Unexpected server response"}));if(!response.ok)throw new Error(data.message||"Request failed");return data};
const show=(message,error=false)=>{status.innerHTML='<div class="notice '+(error?"error":"")+'"></div>';status.firstChild.textContent=message};
document.querySelector("#continue").onclick=async()=>{try{const turnstileToken=document.querySelector('[name="cf-turnstile-response"]')?.value||"";await api("/authorize",{name:document.querySelector("#name").value,email:document.querySelector("#email").value,message:document.querySelector("#message").value,accessCode:document.querySelector("#code").value,turnstileToken});document.querySelector("#identity").classList.add("hidden");document.querySelector("#upload").classList.remove("hidden");show("Secure upload session ready.")}catch(error){show(error.message,true)}};
const picker=document.querySelector("#files"),send=document.querySelector("#send");picker.onchange=()=>send.disabled=!picker.files.length;
send.onclick=async()=>{send.disabled=true;try{for(const file of picker.files){const init=await api("/files/init",{name:file.name,size:file.size,contentType:file.type||"application/octet-stream",lastModified:file.lastModified});const row=document.createElement("div");row.className="file";row.innerHTML="<strong></strong><div class=bar><span></span></div><small></small>";row.querySelector("strong").textContent=file.name;status.append(row);const parts=[];for(let offset=0,partNumber=1;offset<file.size;offset+=partSize,partNumber++){const ticket=await api("/files/"+init.fileId+"/part-ticket",{partNumber});const upload=await fetch(ticket.url,{method:"PUT",body:file.slice(offset,Math.min(file.size,offset+partSize))});if(!upload.ok)throw new Error("A file part failed to upload");const etag=upload.headers.get("etag");if(!etag)throw new Error("Upload CORS must expose the ETag header");parts.push({partNumber,etag});row.querySelector("span").style.width=Math.round(Math.min(file.size,offset+partSize)/file.size*100)+"%";row.querySelector("small").textContent=parts.length+" part(s) uploaded"}await api("/files/"+init.fileId+"/complete",{parts});row.querySelector("small").textContent="Uploaded and queued for scanning"}show("All files uploaded. You may close this page.")}catch(error){show(error.message,true)}finally{send.disabled=false}};
</script></body></html>`;
}
