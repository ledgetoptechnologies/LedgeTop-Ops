// Share a Viewer project, or chosen tasks, straight to a client portal account.
// No business project or Operations model association is needed. The server checks
// the client relationship and current authority again on every grant.
export const DIRECT_CLIENT_GRANTS_PATH='/api/v1/workspace/direct-client-grants';

const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const PERMISSIONS=[['measure','Measurements',true],['cameras','Camera positions',true],['download','Downloads',false]];
const ERRORS={
  relationship_missing:'This client is not connected to Ledge Top yet, so nothing was shared.',
  consent_required:'Confirm the access before sharing.',
  task_not_in_project:'That task is no longer in this project. Reopen Share and choose again.',
  task_not_published:'That task has no published model yet. Publish it first, or share the whole project so it appears once published.',
  expired_at_invalid:'Choose an expiry date in the future, or leave it empty.',
  duplicate_active_grant:'This client already has this access. Revoke it first to change its settings.',
  grant_limit:'This client has reached the maximum number of shares. Revoke one they no longer need first.',
  idempotency_conflict:'This share changed while it was being sent. Check the list below before trying again.',
  forbidden:'You do not have permission to share with clients.',
  invalid_request:'Some of the details were not accepted. Check them and try again.',
};

export function directClientAccess(value){
  return value&&Array.isArray(value.clients)&&Array.isArray(value.grants)?value:null;
}
export function directClientsPath(projectId,{query='',cursor=null}={}){
  const params=new URLSearchParams({viewerProjectId:projectId,limit:'25'});
  if(query.trim())params.set('q',query.trim());if(cursor)params.set('cursor',cursor);
  return `${DIRECT_CLIENT_GRANTS_PATH}?${params}`;
}
export const directClientKey=client=>JSON.stringify([client.sourceId,client.workspaceId]);
export function directClientLabel(client){
  const name=client.displayName||'Client';
  return client.businessName&&client.businessName!==name?`${name} — ${client.businessName}`:name;
}
// Only tasks with a live published model can be shared one by one.
export function shareableTasks(projectId,tasks,outputs){
  const published=new Set(outputs.filter(output=>output.activePublished&&output.status==='published').map(output=>output.taskId));
  return tasks.filter(task=>task.projectId===projectId&&published.has(task.id))
    .map(task=>({id:task.id,name:task.displayName||task.name||'Untitled task'}));
}
export function directScopeSummary({clientName,projectName,scope,taskNames}){
  if(!clientName)return 'Choose a client to see exactly who gets access.';
  const who=`Everyone who signs in to ${clientName}’s portal account`;
  if(scope==='project')return `${who} will see every published task in ${projectName}, including tasks published later.`;
  if(!taskNames.length)return 'Choose at least one task to share.';
  const list=taskNames.length===1?`only “${taskNames[0]}”`:`only these ${taskNames.length} tasks: ${taskNames.map(name=>`“${name}”`).join(', ')}`;
  return `${who} will see ${list}. Other tasks in ${projectName} stay hidden.`;
}
export function directShareErrorText(error){
  return ERRORS[error?.code]||error?.message||'Sharing failed. Nothing was changed.';
}

export function directShareForm({projectName,tasks,access,query='',taskId=null}){
  const clients=access.clients||[],taskMode=Boolean(taskId);
  const options=clients.map(client=>`<option value="${esc(directClientKey(client))}">${esc(directClientLabel(client))}</option>`).join('');
  const taskList=tasks.length?tasks.map(task=>`<label class="check"><input type="checkbox" name="taskId" value="${esc(task.id)}" ${task.id===taskId?'checked':''} ${taskMode?'':'disabled'}> ${esc(task.name)}</label>`).join('')
    :'<p class="form-note">No tasks in this project have a published model yet.</p>';
  return `<form id="direct-client-grant-form" class="manage-form direct-share-form">
<fieldset><legend>Client</legend>
<div class="direct-share-search"><input type="search" name="clientQuery" aria-label="Search clients" placeholder="Search clients" value="${esc(query)}"><button type="button" class="secondary-button" data-action="search-direct-clients">Search</button></div>
<label><span>Client</span><select name="client" required><option value="">${clients.length?'Choose a client':'No matching clients'}</option>${options}</select></label>
${access.clientsNextCursor?'<button type="button" class="secondary-button" data-action="more-direct-clients">Show more clients</button>':''}
<p class="form-note">Access goes to the client’s portal account. Everyone they have invited to it can open what you share.</p>
</fieldset>
<fieldset><legend>What to share</legend>
<label class="check"><input type="radio" name="scope" value="project" ${taskMode?'':'checked'}> The whole project, including tasks published later</label>
<label class="check"><input type="radio" name="scope" value="tasks" ${taskMode?'checked':''} ${tasks.length?'':'disabled'}> Only the tasks I choose</label>
<div class="direct-share-tasks" data-direct-task-list>${taskList}</div>
</fieldset>
<label><span>Expiry (optional)</span><input name="expiresAt" type="datetime-local"></label>
${PERMISSIONS.map(([name,label,checked])=>`<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}> ${label}</label>`).join('')}
<p class="direct-share-summary" role="status" data-direct-summary>${esc(directScopeSummary({clientName:'',projectName,scope:'project',taskNames:[]}))}</p>
<label class="check"><input type="checkbox" name="confirmedScope" required> I confirm this client should get this access</label>
<button class="primary-button">Share with client</button>
</form>`;
}

export function readDirectShareForm(form,{projectId,projectName,tasks,clients}){
  const client=clients.find(item=>directClientKey(item)===form.elements.client.value)||null;
  const scope=form.querySelector('input[name="scope"]:checked')?.value==='tasks'?'tasks':'project';
  const chosen=scope==='tasks'?[...form.querySelectorAll('input[name="taskId"]')].filter(input=>input.checked).map(input=>input.value):[];
  const taskNames=chosen.map(id=>tasks.find(task=>task.id===id)?.name||'Task');
  return {client,scope,chosen,summary:directScopeSummary({clientName:client?directClientLabel(client):'',projectName,scope,taskNames}),
    bodies:()=>{
      if(!client)throw new Error('Choose a client.');
      if(scope==='tasks'&&!chosen.length)throw new Error('Choose at least one task, or share the whole project.');
      if(!form.elements.confirmedScope.checked)throw new Error(ERRORS.consent_required);
      const expires=form.elements.expiresAt.value?new Date(form.elements.expiresAt.value):null;
      if(expires&&!(expires.getTime()>Date.now()))throw new Error(ERRORS.expired_at_invalid);
      const common={sourceId:client.sourceId,workspaceId:client.workspaceId,viewerProjectId:projectId,
        permissions:Object.fromEntries(PERMISSIONS.map(([name])=>[name,form.elements[name].checked])),
        expiresAt:expires?expires.toISOString():null,confirmedScope:true};
      return scope==='project'?[{...common,taskId:null,scopeType:'project',includeFuturePublished:true}]
        :chosen.map(taskId=>({...common,taskId,scopeType:'task',includeFuturePublished:false}));
    }};
}

export function directGrantRows(access,{projectId,tasks,taskId=null,dateTime=value=>value}){
  const grants=access.grants.filter(grant=>!grant.revokedAt&&grant.viewerProjectId===projectId&&(!taskId||grant.scopeType==='project'||grant.taskId===taskId));
  if(!grants.length)return '<div class="empty-state">No clients have access yet.</div>';
  return `<div class="data-list top-gap">${grants.map(grant=>{
    const what=grant.scopeType==='project'?'Whole project, including tasks published later':`Task: ${tasks.find(task=>task.id===grant.taskId)?.name||'Unavailable task'}`;
    const details=[what,grant.expiresAt?`Expires ${dateTime(grant.expiresAt)}`:'No expiry',grant.createdAt?`Shared ${dateTime(grant.createdAt)}`:null].filter(Boolean).join(' · ');
    return `<div class="manage-row"><div><strong>${esc(grant.clientDisplayName||'Client')}</strong><small>${esc(details)}</small></div><span class="status active">active</span><div><button class="secondary-button" data-action="revoke-direct-client-grant" data-id="${esc(grant.grantId)}">Revoke</button></div></div>`;
  }).join('')}</div>`;
}
