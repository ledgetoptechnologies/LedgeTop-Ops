// Share a Viewer project, or chosen tasks, straight to a client portal account.
// No business project or Operations model association is needed. The server checks
// the client relationship and current authority again on every grant.
import { clientBusinessWord, clientPickerLabel, clientPickerMarkup, clientPickerWord } from './workspace-client-picker.mjs';
export { bindClientPicker } from './workspace-client-picker.mjs';
export const DIRECT_CLIENT_GRANTS_PATH='/api/v1/workspace/direct-client-grants';

const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
// What a new client share starts with. Every choice is sent explicitly; existing shares keep theirs.
const PERMISSIONS=[['measure','Measurements',true],['cameras','Camera positions',true],['download','Downloads',true]];
const ERRORS={
  relationship_missing:'This client is not connected to Ledge Top yet, so nothing was shared.',
  consent_required:'Review the share before sending it.',
  task_not_in_project:'That task is no longer in this project. Reopen Share and choose again.',
  task_not_published:'That task has no published model yet. Publish it first, or share the whole project so it appears once published.',
  expired_at_invalid:'Choose an expiry date in the future, or leave it empty.',
  duplicate_active_grant:'This client already has this access. Revoke it first to change its settings.',
  grant_limit:'This client has reached the maximum number of shares. Revoke one they no longer need first.',
  idempotency_conflict:'This share changed while it was being sent. Check the list below before trying again.',
  forbidden:'You do not have permission to share with clients.',
  later_required:'A whole-project share always includes models published later. To share only what is published now, choose the tasks instead.',
  invalid_request:'Some of the details were not accepted. Check them and try again.',
};

export function directClientAccess(value){
  return value&&Array.isArray(value.clients)&&Array.isArray(value.grants)?value:null;
}
// include: 'all' (first clients page + first grants page), 'clients' (picker search) or 'grants'.
// The Share dialog opens with 'grants' only: clients are listed only after staff type a search.
export function directClientsPath(projectId,{query='',cursor=null,include='all',grantsCursor=null}={}){
  const params=new URLSearchParams({viewerProjectId:projectId,limit:'25',include});
  if(query.trim())params.set('q',query.trim());if(cursor)params.set('cursor',cursor);if(grantsCursor)params.set('grantsCursor',grantsCursor);
  return `${DIRECT_CLIENT_GRANTS_PATH}?${params}`;
}
// Grants are paged by the server; follow every page so the access list is complete.
export const DIRECT_GRANT_PAGE_LIMIT=50;
export async function loadDirectClientAccess(api,projectId){
  const first=directClientAccess(await api(directClientsPath(projectId,{include:'grants'})));
  if(!first)return null;
  const grants=[...first.grants];let cursor=first.grantsNextCursor||null,pages=1;
  while(cursor&&pages<DIRECT_GRANT_PAGE_LIMIT){
    const page=directClientAccess(await api(directClientsPath(projectId,{include:'grants',grantsCursor:cursor})));
    if(!page)return null;grants.push(...page.grants);cursor=page.grantsNextCursor||null;pages++;
  }
  return {...first,grants,grantsNextCursor:cursor,grantsIncomplete:!!cursor,clientNames:await sameNameClients(api,projectId,grants)};
}
// A grant carries only the client's name. Where different clients share one, the client search says which business each is in.
async function sameNameClients(api,projectId,grants){
  const keys=new Map(),found=[];
  for(const grant of grants)if(!grant.revokedAt&&grant.viewerProjectId===projectId&&grant.clientDisplayName){
    const name=grant.clientDisplayName.trim();
    if(!keys.has(name))keys.set(name,new Set());
    keys.get(name).add(directClientKey(grant));
  }
  for(const [name] of [...keys].filter(([,same])=>same.size>1).slice(0,5)){
    try{found.push(...(directClientAccess(await api(directClientsPath(projectId,{query:name,include:'clients'})))?.clients||[]))}catch{}
  }
  return found;
}
export const directClientKey=client=>JSON.stringify([client.sourceId,client.workspaceId]);
export const directClientLabel=client=>client?.pickerLabel||clientPickerLabel(client);
// The review names the exact client whatever page of results was loaded: always its business and organisation,
// and the end of its id when another client has all of those too, or when that could not be ruled out.
export function directClientReviewName(client){
  const name=client?.displayName||'Client',organization=client?.organizationName;
  const details=[clientBusinessWord(client?.businessName),organization&&organization!==name?organization:null,
    client?.twin===false||!client?.workspaceId?null:`ref ${String(client.workspaceId).slice(-6)}`].filter(Boolean);
  return `${name}${details.length?` (${details.join(', ')})`:''}`;
}
// Whether another client looks the same in the review. null when the search could not be read to its end.
export async function directClientTwin(api,projectId,client){
  const same=text=>String(text??'').trim().toLocaleLowerCase();
  const look=item=>JSON.stringify([same(item.displayName),same(clientBusinessWord(item.businessName)),same(item.organizationName)]);
  if(same(client.displayName).length<2)return null;
  try{
    for(let cursor=null,pages=0;pages<5;pages++){
      const page=directClientAccess(await api(directClientsPath(projectId,{query:client.displayName,cursor,include:'clients'})));
      if(!page)return null;
      if(page.clients.some(item=>directClientKey(item)!==directClientKey(client)&&look(item)===look(client)))return true;
      cursor=page.clientsNextCursor||null;
      if(!cursor)return false;
    }
  }catch{}
  return null;
}
// Only tasks with a live published model can be shared one by one.
export function shareableTasks(projectId,tasks,outputs){
  const published=new Set(outputs.filter(output=>output.activePublished&&output.status==='published').map(output=>output.taskId));
  return tasks.filter(task=>task.projectId===projectId&&published.has(task.id))
    .map(task=>({id:task.id,name:task.displayName||task.name||'Untitled task'}));
}
export function directScopeSummary({clientName,projectName,scope,taskNames}){
  if(!clientName)return '';
  const who=`Authorized members of ${clientName}’s portal account`;
  if(scope==='project')return `${who} will see every published task in ${projectName}, including tasks published later.`;
  if(!taskNames.length)return 'Choose at least one task to share.';
  const list=taskNames.length===1?`only “${taskNames[0]}”`:`only these ${taskNames.length} tasks: ${taskNames.map(name=>`“${name}”`).join(', ')}`;
  return `${who} will see ${list}. Other tasks in ${projectName} stay hidden.`;
}
export function directShareErrorText(error){
  return ERRORS[error?.code]||error?.message||'Sharing failed. Nothing was changed.';
}

// A Share opened from the project starts on the whole project; one opened from a task starts on that task,
// and never on the whole project, even when that task cannot be shared yet.
// "Also share models published later" starts ticked with the whole project, and the review says so before anything is sent.
export function directShareDefaultScope({entry=null,taskId=null}={}){return (entry||(taskId?'task':'project'))==='project'?'project':'tasks'}
const permissionList=permissions=>{
  const can=['view',permissions?.measure&&'measure',permissions?.cameras&&'see camera positions',permissions?.download&&'download'].filter(Boolean);
  return can.length>1?`${can.slice(0,-1).join(', ')} and ${can.at(-1)}`:can[0];
};
// The review step repeats exactly what will be sent: who, what, permissions and end.
export function directShareReviewMarkup({client,what,permissions,expiresAt,dateTime=value=>value}){
  const can=permissionList(permissions);
  const name=directClientReviewName(client);
  return [['Client',name],['Who',`Everyone in ${name}’s portal account`],['Shared',what],['Can',can[0].toUpperCase()+can.slice(1)],
    ['Ends',expiresAt?dateTime(expiresAt):'No end date']]
    .map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('');
}

// The task this Share was opened on is gone from the project: nothing can be shared from here.
export const SHARE_TARGET_MISSING='This task or its model is no longer in this project, so it can’t be shared from here. Close Share and open it again.';
export function directShareForm({projectName,tasks,entry=null,taskId=null,taskName='',targetMissing=false}){
  if(targetMissing)return `<p class="form-note" role="alert">${esc(SHARE_TARGET_MISSING)}</p>`;
  const scope=directShareDefaultScope({entry,taskId}),unpublished=taskId&&!tasks.some(task=>task.id===taskId);
  const taskList=tasks.length?tasks.map(task=>`<label class="check"><input type="checkbox" name="taskId" value="${esc(task.id)}" ${task.id===taskId?'checked':''}> ${esc(task.name)}</label>`).join('')
    :'<p class="form-note">No tasks in this project have a published model yet.</p>';
  const notice=unpublished?`<p class="form-note" role="status">${taskName?`“${esc(taskName)}”`:'This task'} is not published yet, so a client cannot be given it on its own. Publish it first.</p>`:'';
  return `<form id="direct-client-grant-form" class="manage-form share-dialog-form direct-share-form">
<fieldset><legend>Client</legend>
${clientPickerMarkup()}
</fieldset>
<fieldset><legend>What to share</legend>
<label class="check"><input type="radio" name="scope" value="project" ${scope==='project'?'checked':''}> The whole project</label>
<label class="check direct-share-later"><input type="checkbox" name="includeLater" ${scope==='project'?'checked':'disabled'}> Also share models published later</label>
<label class="check"><input type="radio" name="scope" value="tasks" ${scope==='tasks'?'checked':''} ${tasks.length||unpublished?'':'disabled'}> Only the tasks I choose</label>
${notice}<div class="direct-share-tasks" data-direct-task-list>${taskList}</div>
</fieldset>
<label><span>Expiry (optional)</span><input name="expiresAt" type="datetime-local"></label>
${PERMISSIONS.map(([name,label,checked])=>`<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}> ${label}</label>`).join('')}
<p class="direct-share-summary" role="status" data-direct-summary></p>
<section class="direct-share-review" data-direct-review hidden tabindex="-1" aria-label="Review share"><h3>Review share</h3><dl data-direct-review-text></dl>
<div class="action-row"><button class="primary-button" data-direct-send>Share with client</button><button type="button" class="secondary-button" data-direct-back>Back</button></div></section>
<button class="primary-button" data-direct-review-button>Review share</button>
</form>`;
}

export function readDirectShareForm(form,{projectId,projectName,tasks,clients}){
  const client=clients.find(item=>directClientKey(item)===form.elements.client.value)||null;
  const scope=form.querySelector('input[name="scope"]:checked')?.value==='project'?'project':'tasks';
  const chosen=scope==='tasks'?[...form.querySelectorAll('input[name="taskId"]')].filter(input=>input.checked).map(input=>input.value):[];
  const taskNames=chosen.map(id=>tasks.find(task=>task.id===id)?.name||'Task');
  const now=!tasks.length?'nothing published yet':tasks.length>5?`${tasks.length} published tasks now`:tasks.map(task=>`“${task.name}”`).join(', ');
  const what=scope==='project'?`Whole project ${projectName}: ${now} and later ones`
    :`${taskNames.length===1?'Task':`${taskNames.length} tasks`} ${taskNames.map(name=>`“${name}”`).join(', ')}`;
  return {client,scope,chosen,what,published:scope==='project'?tasks.map(task=>task.id).sort():chosen,summary:directScopeSummary({clientName:client?directClientLabel(client):'',projectName,scope,taskNames}),
    // confirmed is true only for the Share click on the review.
    bodies:({confirmed=false}={})=>{
      if(!client)throw new Error('Choose a client.');
      if(scope==='tasks'&&!chosen.length)throw new Error('Choose at least one task, or share the whole project.');
      // The contract has no project share without later models: the box must be ticked on purpose.
      if(scope==='project'&&!form.elements.includeLater?.checked)throw new Error(ERRORS.later_required);
      const expires=form.elements.expiresAt.value?new Date(form.elements.expiresAt.value):null;
      if(expires&&!(expires.getTime()>Date.now()))throw new Error(ERRORS.expired_at_invalid);
      const common={sourceId:client.sourceId,workspaceId:client.workspaceId,viewerProjectId:projectId,
        permissions:Object.fromEntries(PERMISSIONS.map(([name])=>[name,form.elements[name].checked])),
        expiresAt:expires?expires.toISOString():null,confirmedScope:confirmed===true};
      return scope==='project'?[{...common,taskId:null,scopeType:'project',includeFuturePublished:true}]
        :chosen.map(taskId=>({...common,taskId,scopeType:'task',includeFuturePublished:false}));
    }};
}

export function directGrantRows(access,{projectId,tasks,taskId=null,dateTime=value=>value,now=Date.now()}){
  const grants=access.grants.filter(grant=>!grant.revokedAt&&grant.viewerProjectId===projectId&&(!taskId||grant.scopeType==='project'||grant.taskId===taskId));
  const known=new Map((access.clientNames||[]).map(client=>[directClientKey(client),client]));
  const named=grant=>({...known.get(directClientKey(grant)),sourceId:grant.sourceId,workspaceId:grant.workspaceId,displayName:grant.clientDisplayName});
  const incomplete=access.grantsIncomplete?'<p class="form-note" role="status">Some shares could not be listed. Close and reopen Share to load the rest.</p>':'';
  if(!grants.length)return incomplete||'<div class="empty-state">No clients have access yet.</div>';
  return `${incomplete}<div class="data-list top-gap">${grants.map(grant=>{
    const what=grant.scopeType==='project'?'Whole project, including models published later':`Task: ${tasks.find(task=>task.id===grant.taskId)?.name||'Unavailable task'}`;
    // An expired share gives no access, but it still holds its place until it is revoked.
    const expired=Boolean(grant.expiresAt)&&!(Date.parse(grant.expiresAt)>now);
    const details=[grant.permissions?`Can ${permissionList(grant.permissions)}`:null,
      expired?`Expired${Number.isNaN(Date.parse(grant.expiresAt))?', end date unknown':` ${dateTime(grant.expiresAt)}`}; revoke it to share this again`:grant.expiresAt?`Expires ${dateTime(grant.expiresAt)}`:'No end date'].filter(Boolean).join(' · ');
    const word=clientPickerWord(named(grant),grants.map(named));
    return `<div class="manage-row share-access-row"><div><strong>${esc(grant.clientDisplayName||'Client')}${word?` <span class="client-picker-meta">${esc(word)}</span>`:''}</strong><small>${esc(what)}</small><small>${esc(details)}</small></div><div class="row-actions">${expired?'<span class="status expired">expired</span>':''}<button class="secondary-button" data-action="revoke-direct-client-grant" data-id="${esc(grant.grantId)}">Revoke</button></div></div>`;
  }).join('')}</div>`;
}

// Who a publication adds: clients whose live share covers this task once it is published.
// A task share can outlive its model, so a task being published again counts too.
export function publishAudience(access,{projectId,taskId,now=Date.now()}){
  const clients=new Map();
  for(const grant of access.grants){
    if(grant.revokedAt||grant.viewerProjectId!==projectId||grant.expiresAt&&!(Date.parse(grant.expiresAt)>now))continue;
    if(grant.scopeType==='project'||grant.scopeType==='task'&&grant.taskId===taskId)
      clients.set(directClientKey(grant),{key:directClientKey(grant),name:grant.clientDisplayName||'a client',id:grant.workspaceId});
  }
  return [...clients.values()];
}
const NAMED_CLIENTS=5;
// One line per client, in name order. Clients that share a name carry the end of their id, as in the client search.
export function publishAudienceNames(clients){
  const fold=name=>name.toLocaleLowerCase(),count=new Map();
  for(const client of clients)count.set(fold(client.name),(count.get(fold(client.name))||0)+1);
  return clients.map(client=>count.get(fold(client.name))>1?`${client.name} (ref ${String(client.id||client.key).slice(-6)})`:client.name)
    .sort((left,right)=>left.localeCompare(right));
}
// Nothing to say only when every list was read in full and no client gains the task.
export function publishAudienceText(names,{complete}){
  if(!names.length)return complete?'':'Client access could not be checked. Publishing this task shows it to every client who has the whole project.';
  const shown=names.slice(0,NAMED_CLIENTS),more=names.length-shown.length;
  const parts=more?[...shown,`${more} other client${more===1?'':'s'}`]:shown;
  const list=parts.length>1?`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`:parts[0];
  return `Publishing this task shows it to ${list}.${complete?'':' Some client access could not be checked: any other client who has the whole project will see it too.'}`;
}
