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
.honeypot{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important;overflow:hidden!important}.file-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.cancel{padding:6px 10px;background:#fff;color:#8c2424;border:1px solid #d9a6a6;font-size:.82rem}
.status{margin-top:16px;display:grid;gap:10px}.file,.notice{background:#eef3f7;border-radius:10px;padding:12px}.notice.error{background:#fff0f0;color:#8c2424}.notice.ok{background:#edf7ed;color:#245b2b}
.notice.warning{background:#fff7df;color:#765409}.drop input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.drop:focus-within,input:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid #2b6cb0;outline-offset:3px}.hint{font-size:.9rem;color:#64748b}
.bar{height:7px;background:#d4dde6;border-radius:999px;overflow:hidden;margin-top:8px}.bar span{display:block;height:100%;background:#f05a14;transition:width .2s}.file small{display:block;margin-top:6px;color:#59687a}
@media(max-width:580px){.grid{grid-template-columns:1fr}.panel{padding:20px}}
</style>${siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
</head><body><main class="panel"><h1>${escapeHtml(input.title)}</h1>
<p>Send files securely to Ledge Top Drone Services. Files upload directly into a private incoming area.</p>
<section id="identity"><div class="grid"><div class="field"><label for="name">Your name</label><input id="name" maxlength="120" autocomplete="name" required></div>
<div class="field"><label for="email">Email</label><input id="email" type="email" maxlength="254" autocomplete="email" required></div></div>
<div class="field"><label for="message">Message (optional)</label><textarea id="message" maxlength="2000"></textarea></div>
<div class="field"><label for="code">Access code (if provided)</label><input id="code" type="password" maxlength="128"></div>
<div class="honeypot" aria-hidden="true"><label for="website">Website</label><input id="website" type="text" tabindex="-1" autocomplete="off"></div>
${turnstile}<button id="continue" type="button">Continue securely</button><p class="hint">Your files are quarantined for LTDS processing before they can be delivered.</p></section>
<section id="upload" class="hidden"><label class="drop" id="drop" for="files"><strong>Choose or drop files</strong><p>Uploads begin automatically. To resume after reopening this page, select the same files again.</p><input id="files" type="file" multiple></label></section>
<div id="status" class="status" aria-live="polite"></div></main>
<script>
const requestId=${id}, statusBox=document.querySelector("#status"), picker=document.querySelector("#files"), drop=document.querySelector("#drop");
const api=async(path,body,method="POST")=>{const response=await fetch("/api/public/requests/"+encodeURIComponent(requestId)+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json().catch(()=>({message:"Unexpected server response"}));if(!response.ok)throw new Error(data.message||data.error||("Request failed ("+response.status+")"));return data};
const notice=(message,kind="")=>{const row=document.createElement("div");row.className="notice "+kind;row.textContent=message;statusBox.prepend(row)};
const db=()=>new Promise((resolve,reject)=>{const open=indexedDB.open("ltds-incoming-v1",1);open.onupgradeneeded=()=>open.result.createObjectStore("uploads",{keyPath:"key"});open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error)});
const getSaved=async(key)=>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction("uploads").objectStore("uploads").get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})};
const putSaved=async(value)=>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction("uploads","readwrite").objectStore("uploads").put(value);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)})};
const deleteSaved=async(key)=>{const database=await db();return new Promise((resolve,reject)=>{const request=database.transaction("uploads","readwrite").objectStore("uploads").delete(key);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)})};
const hex=bytes=>[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,"0")).join("");
const fingerprint=async file=>{const size=64*1024,first=await file.slice(0,Math.min(file.size,size)).arrayBuffer(),last=await file.slice(Math.max(0,file.size-size),file.size).arrayBuffer(),meta=new TextEncoder().encode([file.name,file.size,file.type||"application/octet-stream",file.lastModified].join(":")),bytes=new Uint8Array(meta.byteLength+first.byteLength+last.byteLength);bytes.set(meta);bytes.set(new Uint8Array(first),meta.byteLength);bytes.set(new Uint8Array(last),meta.byteLength+first.byteLength);return hex(await crypto.subtle.digest("SHA-256",bytes))};
const savedKey=value=>"request:"+requestId+":"+value;
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const putPart=(ticket,blob,onProgress,setCurrent)=>new Promise((resolve,reject)=>{if(ticket.contentLength!==blob.size)throw new Error("The upload ticket size did not match this part");const xhr=new XMLHttpRequest();setCurrent(xhr);xhr.open("PUT",ticket.url);xhr.withCredentials=false;xhr.setRequestHeader("content-type",ticket.contentType);xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded)};xhr.onerror=()=>reject(new Error("The browser could not reach R2"));xhr.onabort=()=>reject(new Error("Upload cancelled"));xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve(xhr):reject(new Error("R2 rejected the upload part ("+xhr.status+")"));xhr.send(blob)});
const uploadFile=async(file)=>{
  const resumeFingerprint=await fingerprint(file),key=savedKey(resumeFingerprint),prior=await getSaved(key).catch(()=>null),clientUploadId=prior?.resumeFingerprint===resumeFingerprint?prior.clientUploadId:crypto.randomUUID();
  let cancelled=false,currentXhr=null,fileId=null;const row=document.createElement("div");row.className="file";row.innerHTML="<div class=file-head><strong></strong><button class=cancel type=button>Cancel</button></div><div class=bar><span></span></div><small></small>";row.querySelector("strong").textContent=file.name;statusBox.append(row);
  row.querySelector(".cancel").onclick=async()=>{cancelled=true;currentXhr?.abort();row.querySelector(".cancel").disabled=true;if(fileId){try{await api("/files/"+fileId,undefined,"DELETE");await deleteSaved(key).catch(()=>{});row.querySelector("small").textContent="Cancelled"}catch(error){notice(file.name+": "+error.message,"error");row.querySelector(".cancel").disabled=false}}};
  const init=await api("/files/init",{clientUploadId,name:file.name,size:file.size,contentType:file.type||"application/octet-stream",lastModified:file.lastModified,resumeFingerprint});fileId=init.fileId;
  await putSaved({key,clientUploadId,fileId:init.fileId,resumeFingerprint,name:file.name,size:file.size,lastModified:file.lastModified}).catch(()=>{});
  if(cancelled){await api("/files/"+init.fileId,undefined,"DELETE");await deleteSaved(key).catch(()=>{});throw new Error("Upload cancelled")}
  if(init.status==="quarantined"||init.status==="accepted"){row.querySelector("span").style.width="100%";row.querySelector("small").textContent="Already uploaded";row.querySelector(".cancel").remove();await deleteSaved(key).catch(()=>{});return}
  const completed=new Map((init.completedParts||[]).map(part=>[part.partNumber,part])), parts=[], count=Math.ceil(file.size/init.partSize);
  for(let partNumber=1;partNumber<=count;partNumber++){
    const offset=(partNumber-1)*init.partSize, end=Math.min(file.size,offset+init.partSize), existing=completed.get(partNumber);
    if(existing){parts.push({partNumber,etag:existing.etag})}
    else{
      let uploaded;
      for(let attempt=1;attempt<=3;attempt++){try{if(cancelled)throw new Error("Upload cancelled");const ticket=await api("/files/"+init.fileId+"/part-ticket",{partNumber});uploaded=await putPart(ticket,file.slice(offset,end),loaded=>{row.querySelector("span").style.width=Math.round((offset+loaded)/file.size*100)+"%"},value=>{currentXhr=value});break}catch(error){if(cancelled||attempt===3)throw error;await wait(250*2**(attempt-1))}}
      const etag=uploaded.getResponseHeader("etag");if(!etag)throw new Error("Upload CORS must expose the ETag header");
      const checkpoint=await api("/files/"+init.fileId+"/parts/"+partNumber,{etag,size:end-offset},"PUT");parts.push({partNumber,etag:checkpoint.etag});
    }
    row.querySelector("span").style.width=Math.round(end/file.size*100)+"%";row.querySelector("small").textContent=partNumber+" of "+count+" parts";
  }
  if(cancelled)throw new Error("Upload cancelled");await api("/files/"+init.fileId+"/complete",{parts});await deleteSaved(key).catch(()=>{});row.querySelector("small").textContent="Uploaded successfully";row.querySelector(".cancel").remove();
};
let uploadBusy=false;const uploadFiles=async(files)=>{const selected=[...files];if(!selected.length){notice("No files were selected.","error");return}if(uploadBusy){notice("Please wait for the current upload to finish.","warning");return}uploadBusy=true;picker.disabled=true;let succeeded=0;try{for(const file of selected){try{if(!file.size)throw new Error("Empty files cannot be uploaded");await uploadFile(file);succeeded++}catch(error){notice(file.name+": "+error.message+". You can select the file again to retry.","error")}}}finally{uploadBusy=false;picker.disabled=false}const failed=selected.length-succeeded,kind=failed===0?"ok":succeeded===0?"error":"warning";notice(succeeded+" of "+selected.length+" files uploaded"+(failed?"; "+failed+" failed.":" successfully."),kind)};
document.querySelector("#continue").onclick=async(event)=>{const button=event.currentTarget,name=document.querySelector("#name"),email=document.querySelector("#email");if(!name.reportValidity()||!email.reportValidity())return;button.disabled=true;button.textContent="Checking...";try{const token=document.querySelector('[name="cf-turnstile-response"]')?.value||"";await api("/authorize",{name:name.value.trim(),email:email.value.trim(),message:document.querySelector("#message").value,accessCode:document.querySelector("#code").value,turnstileToken:token,website:document.querySelector("#website").value});document.querySelector("#identity").classList.add("hidden");document.querySelector("#upload").classList.remove("hidden");notice("Secure upload session ready.","ok")}catch(error){notice(error.message,"error");button.disabled=false;button.textContent="Continue securely"}};
picker.onchange=()=>{const files=[...picker.files];picker.value="";void uploadFiles(files)};["dragenter","dragover"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add("drag")}));["dragleave","drop"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.remove("drag")}));drop.addEventListener("drop",event=>{void uploadFiles([...event.dataTransfer.files])});
</script></body></html>`;
}
