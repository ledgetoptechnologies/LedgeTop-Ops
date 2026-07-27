function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function incomingRequestPage(input: {
  publicId: string;
  title: string;
  turnstileSiteKey?: string;
}): string {
  const id = JSON.stringify(input.publicId);
  const siteKey = escapeHtml(input.turnstileSiteKey || "");
  const turnstile = siteKey
    ? `<div class="cf-turnstile" data-sitekey="${siteKey}" data-action="incoming-upload"></div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#152033;background:#f3f6f9}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.panel{width:min(760px,100%);background:#fff;border:1px solid #dbe3ea;border-radius:18px;box-shadow:0 18px 55px #25354d18;padding:28px}
h1{margin:0 0 8px;font-size:clamp(1.65rem,4vw,2.25rem)}p{color:#5b6878;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:6px;margin:14px 0}
label{font-weight:650}input,textarea{width:100%;border:1px solid #b9c5d2;border-radius:10px;padding:12px;font:inherit}textarea{min-height:86px}
.drop{border:2px dashed #9cb4cc;border-radius:14px;padding:30px;text-align:center;background:#f8fafc;cursor:pointer}.drop.drag{border-color:#f05a14;background:#fff6f1}.drop input{border:0;padding:0}
button{border:0;border-radius:10px;background:#f05a14;color:#fff;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.55}.hidden{display:none}
.status{margin-top:16px;display:grid;gap:10px}.file,.notice{background:#eef3f7;border-radius:10px;padding:12px}.notice.error{background:#fff0f0;color:#8c2424}.notice.ok{background:#edf7ed;color:#245b2b}
.bar{height:7px;background:#d4dde6;border-radius:999px;overflow:hidden;margin-top:8px}.bar span{display:block;height:100%;background:#f05a14;transition:width .2s}.file small{display:block;margin-top:6px;color:#59687a}
@media(max-width:580px){.grid{grid-template-columns:1fr}.panel{padding:20px}}
</style>${siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
</head><body><main class="panel"><h1>${escapeHtml(input.title)}</h1>
<p>Send files securely to Ledge Top Drone Services. Files upload directly into a private incoming area.</p>
<section id="identity"><div class="grid"><div class="field"><label for="name">Your name</label><input id="name" maxlength="120" autocomplete="name"></div>
<div class="field"><label for="email">Email</label><input id="email" type="email" maxlength="254" autocomplete="email"></div></div>
<div class="field"><label for="message">Message (optional)</label><textarea id="message" maxlength="2000"></textarea></div>
<div class="field"><label for="code">Access code (if provided)</label><input id="code" type="password" maxlength="128"></div>
${turnstile}<button id="continue">Continue</button></section>
<section id="upload" class="hidden"><label class="drop" id="drop" for="files"><strong>Choose or drop files</strong><p>Uploads begin automatically. To resume after reopening this page, select the same files again.</p><input id="files" type="file" multiple></label></section>
<div id="status" class="status" aria-live="polite"></div></main>
<script>
const requestId=${id}, statusBox=document.querySelector("#status"), picker=document.querySelector("#files"), drop=document.querySelector("#drop");
const api=async(path,body,method="POST")=>{const response=await fetch("/api/public/requests/"+encodeURIComponent(requestId)+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json().catch(()=>({message:"Unexpected server response"}));if(!response.ok)throw new Error(data.message||"Request failed");return data};
const notice=(message,kind="")=>{const row=document.createElement("div");row.className="notice "+kind;row.textContent=message;statusBox.prepend(row)};
const db=()=>new Promise((resolve,reject)=>{const open=indexedDB.open("ltds-incoming-v1",1);open.onupgradeneeded=()=>open.result.createObjectStore("uploads",{keyPath:"key"});open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error)});
const getSaved=async(key)=>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction("uploads").objectStore("uploads").get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})};
const putSaved=async(value)=>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction("uploads","readwrite").objectStore("uploads").put(value);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)})};
const fingerprint=file=>[file.name,file.size,file.type||"application/octet-stream",file.lastModified].join(":");
const savedKey=file=>"request:"+requestId+":"+fingerprint(file);
const uploadFile=async(file)=>{
  const key=savedKey(file), prior=await getSaved(key), clientUploadId=prior?.clientUploadId||crypto.randomUUID();
  const row=document.createElement("div");row.className="file";row.innerHTML="<strong></strong><div class=bar><span></span></div><small></small>";row.querySelector("strong").textContent=file.name;statusBox.append(row);
  const init=await api("/files/init",{clientUploadId,name:file.name,size:file.size,contentType:file.type||"application/octet-stream",lastModified:file.lastModified});
  await putSaved({key,clientUploadId,fileId:init.fileId,name:file.name,size:file.size,lastModified:file.lastModified});
  if(init.status==="quarantined"||init.status==="accepted"){row.querySelector("span").style.width="100%";row.querySelector("small").textContent="Already uploaded";return}
  const completed=new Map((init.completedParts||[]).map(part=>[part.partNumber,part])), parts=[], count=Math.ceil(file.size/init.partSize);
  for(let partNumber=1;partNumber<=count;partNumber++){
    const offset=(partNumber-1)*init.partSize, end=Math.min(file.size,offset+init.partSize), existing=completed.get(partNumber);
    if(existing){parts.push({partNumber,etag:existing.etag})}
    else{
      let uploaded;
      for(let attempt=1;attempt<=3;attempt++){try{const ticket=await api("/files/"+init.fileId+"/part-ticket",{partNumber});uploaded=await fetch(ticket.url,{method:"PUT",body:file.slice(offset,end)});if(!uploaded.ok)throw new Error("Part upload failed");break}catch(error){if(attempt===3)throw error}}
      const etag=uploaded.headers.get("etag");if(!etag)throw new Error("Upload CORS must expose the ETag header");
      await api("/files/"+init.fileId+"/parts/"+partNumber,{etag,size:end-offset},"PUT");parts.push({partNumber,etag});
    }
    row.querySelector("span").style.width=Math.round(end/file.size*100)+"%";row.querySelector("small").textContent=partNumber+" of "+count+" parts";
  }
  await api("/files/"+init.fileId+"/complete",{parts});row.querySelector("small").textContent="Uploaded successfully";
};
const uploadFiles=async(files)=>{let succeeded=0;for(const file of files){try{await uploadFile(file);succeeded++}catch(error){notice(file.name+": "+error.message,"error")}}notice(succeeded+" file"+(succeeded===1?"":"s")+" uploaded successfully.","ok")};
document.querySelector("#continue").onclick=async()=>{try{const token=document.querySelector('[name="cf-turnstile-response"]')?.value||"";await api("/authorize",{name:document.querySelector("#name").value,email:document.querySelector("#email").value,message:document.querySelector("#message").value,accessCode:document.querySelector("#code").value,turnstileToken:token});document.querySelector("#identity").classList.add("hidden");document.querySelector("#upload").classList.remove("hidden");notice("Secure upload session ready.","ok")}catch(error){notice(error.message,"error")}};
picker.onchange=()=>{if(picker.files.length)uploadFiles([...picker.files])};["dragenter","dragover"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add("drag")}));["dragleave","drop"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.remove("drag")}));drop.addEventListener("drop",event=>{if(event.dataTransfer.files.length)uploadFiles([...event.dataTransfer.files])});
</script></body></html>`;
}
