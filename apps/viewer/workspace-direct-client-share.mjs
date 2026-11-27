// Share a Viewer project, or chosen tasks, straight to a client portal account.
// No business project or Operations model association is needed. The server checks
// the client relationship and current authority again on every grant.
import { clientBusinessWord, clientPickerLabel, clientPickerMarkup, clientPickerWord } from './workspace-client-picker.mjs';
export { bindClientPicker } from './workspace-client-picker.mjs';
export const DIRECT_CLIENT_GRANTS_PATH='/api/v1/workspace/direct-client-grants';
export const DIRECT_CLIENT_GROUPS_PATH='/api/v1/workspace/direct-client-groups';
export const DIRECT_CLIENT_GROUPS_TIMEOUT_MS=2500;

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
  share_replacement_limit:'This client has more than 100 shares in this project. In Clients with access, revoke shares they no longer need one at a time, then try again.',
  share_changed:'This client’s shares changed. Return to the access list and review the current share before editing again.',
  idempotency_conflict:'This share changed while it was being sent. Check the list below before trying again.',
  forbidden:'You do not have permission to share with clients.',
  later_required:'A whole-project share always includes models published later. To share only what is published now, choose the tasks instead.',
  selection_not_in_project:'The selected folders or tasks changed. Close and reopen Share to choose again.',
  selection_unsupported:'The Viewer must be updated before it can share part of a project.',
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
// Replacement support belongs to this project read, not to rows or picker searches.
// A mixed-version page set must not retain an earlier page's capability.
export const DIRECT_GRANT_PAGE_LIMIT=50;
export async function loadDirectClientAccess(api,projectId){
  const first=directClientAccess(await api(directClientsPath(projectId,{include:'grants'})));
  if(!first)return null;
  const grants=[...first.grants];let cursor=first.grantsNextCursor||null,pages=1,replaces=first.capabilities?.replaces===true;
  // Only the first page is asked whether Operations can email the client.
  const notifyClient=first.capabilities?.notifyClient===true;
  while(cursor&&pages<DIRECT_GRANT_PAGE_LIMIT){
    const page=directClientAccess(await api(directClientsPath(projectId,{include:'grants',grantsCursor:cursor})));
    if(!page)return null;replaces=replaces&&page.capabilities?.replaces===true;
    grants.push(...page.grants);cursor=page.grantsNextCursor||null;pages++;
  }
  return {...first,listedProjectId:projectId,capabilities:{replaces,...(notifyClient?{notifyClient}:{})},grants,grantsNextCursor:cursor,grantsIncomplete:!!cursor,clientNames:await sameNameClients(api,projectId,grants)};
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
// Asked once when Share opens. Operations links a client's workspaces in different divisions only through a reviewed
// shared profile. A slow, failed or older Operations answers nothing here, and every workspace stays its own row.
// Returns workspace key -> group key; the map never changes afterwards.
export async function loadDirectClientGroups(api,{timeoutMs=DIRECT_CLIENT_GROUPS_TIMEOUT_MS,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const groups=new Map(),abort=typeof AbortController==='function'?new AbortController():null;let timer=null;
  try{
    const late=new Promise(resolve=>{timer=setTimer(()=>{abort?.abort();resolve(null)},timeoutMs)});
    const value=await Promise.race([api(DIRECT_CLIENT_GROUPS_PATH,{signal:abort?.signal}).catch(()=>null),late]);
    if(!value||!Array.isArray(value.groups))return groups;
    const valid=group=>Array.isArray(group)&&group.length>=2&&group.length<=4
      &&group.every(pair=>Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string'&&typeof pair[1]==='string');
    const found=new Map();
    for(const group of value.groups.slice(0,250)){
      if(!valid(group))continue;const key=JSON.stringify(group);
      for(const [sourceId,workspaceId] of group){const workspace=directClientKey({sourceId,workspaceId});found.set(workspace,found.has(workspace)?null:key)}
    }
    // A workspace listed in two groups joins nothing.
    for(const [workspace,key] of found)if(key)groups.set(workspace,key);
    return groups;
  }finally{if(timer!==null)clearTimer(timer)}
}
export const directClientGroupOf=groups=>client=>groups?.get(directClientKey(client))||null;
// Where one client is in several divisions, staff choose the portal account the share goes to; it is never guessed.
export function directDestinationMarkup(client){
  const members=client?.members?.length>1?client.members:null;if(!members)return '';
  return `<fieldset class="direct-share-destination"><legend>Portal account</legend>${members.map(member=>
    `<label class="check"><input type="radio" name="destination" value="${esc(directClientKey(member))}"> ${esc(clientBusinessWord(member.businessName)||member.businessName||'Client')}`
    +`<small class="direct-share-reference">Workspace ${esc(member.workspaceId)}</small></label>`).join('')}</fieldset>`;
}
export const directClientLabel=client=>client?.pickerLabel||clientPickerLabel(client);
// The review names the exact client: always its business and organisation, and its full workspace reference.
export function directClientReviewName(client){
  const name=client?.displayName||'Client',organization=client?.organizationName;
  const details=[clientBusinessWord(client?.businessName),organization&&organization!==name?organization:null].filter(Boolean);
  return `${name}${details.length?` (${details.join(', ')})`:''}`;
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
// Saved replacements use a plain-text confirmation, with the saved permissions and end unchanged.
export function directProjectShareReviewText({summary,permissions,expiresAt,dateTime=value=>value}){
  return `${summary} They can ${permissionList(permissions)}. ${expiresAt?`Access ends ${dateTime(expiresAt)}.`:'No end date.'}`;
}
// The review step repeats exactly what will be sent: who, what, permissions and end.
export function directShareReviewMarkup({client,what,permissions,expiresAt,dateTime=value=>value}){
  const can=permissionList(permissions);
  const name=directClientReviewName(client);
  return [['Client',name],['Who',`Authorized members of ${name}’s portal account`],['Shared',what],['Can',can[0].toUpperCase()+can.slice(1)],
    ['Ends',expiresAt?dateTime(expiresAt):'No end date']]
    .map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}${label==='Client'&&client?.workspaceId?`<small class="direct-share-reference">Workspace ${esc(client.workspaceId)}</small>`:''}</dd>`).join('');
}

// The task this Share was opened on is gone from the project: nothing can be shared from here.
export const SHARE_TARGET_MISSING='This task or its model is no longer in this project, so it can’t be shared from here. Close Share and open it again.';
// notifyClient: Operations said it can email the client. Otherwise no box is shown.
export function directShareForm({projectName,tasks,entry=null,taskId=null,taskName='',targetMissing=false,selectionCatalog=null,notifyClient=false}){
  if(targetMissing)return `<p class="form-note" role="alert">${esc(SHARE_TARGET_MISSING)}</p>`;
  const scope=directShareDefaultScope({entry,taskId}),unpublished=taskId&&!tasks.some(task=>task.id===taskId);
  const projectEntry=scope==='project';
  const taskList=tasks.length?tasks.map(task=>`<label class="check"><input type="checkbox" name="taskId" value="${esc(task.id)}" ${task.id===taskId?'checked':''}> ${esc(task.name)}</label>`).join('')
    :'<p class="form-note">No tasks in this project have a published model yet.</p>';
  const notice=unpublished?`<p class="form-note" role="status">${taskName?`“${esc(taskName)}”`:'This task'} is not published yet, so a client cannot be given it on its own. Publish it first.</p>`:'';
  return `<form id="direct-client-grant-form" class="manage-form share-dialog-form direct-share-form">
<fieldset><legend>Client</legend>
${clientPickerMarkup()}
<div data-direct-destination></div>
</fieldset>
<fieldset><legend>What to share</legend>
<label class="check"><input type="radio" name="scope" value="project" ${projectEntry?'checked':''}> ${projectEntry?'Project access':'The whole project'}</label>
${projectEntry?projectSelectionFields(selectionCatalog):''}
<label class="check direct-share-later"><input type="checkbox" name="includeLater" ${scope==='project'?'checked':'disabled'}> Also share models published later</label>
<label class="check"><input type="radio" name="scope" value="tasks" ${scope==='tasks'?'checked':''} ${tasks.length||unpublished?'':'disabled'}> Only the tasks I choose</label>
${notice}<div class="direct-share-tasks" data-direct-task-list>${taskList}</div>
</fieldset>
<label><span>Expiry (optional)</span><input name="expiresAt" type="datetime-local"></label>
${PERMISSIONS.map(([name,label,checked])=>`<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}> ${label}</label>`).join('')}
${notifyClient?'<label class="check"><input type="checkbox" name="notifyClient" checked> Email client</label>':''}
<p class="direct-share-summary" role="status" data-direct-summary></p>
<section class="direct-share-review" data-direct-review hidden tabindex="-1" aria-label="Review share"><h3>Review share</h3><dl data-direct-review-text></dl>
<div class="action-row"><button class="primary-button" data-direct-send>Share with client</button><button type="button" class="secondary-button" data-direct-back>Back</button></div></section>
<button class="primary-button" data-direct-review-button>Review share</button>
</form>`;
}

export function readDirectShareForm(form,{projectId,projectName,tasks,clients,known=tasks,fresh=false,entry=null,selectionCatalog=null}){
  const picked=clients.find(item=>directClientKey(item)===form.elements.client.value)||null;
  // A client in several divisions is sent to the one portal account chosen for it, never to all of them.
  const destinations=picked?.members?.length>1?picked.members:null;
  const chosenDestination=form.querySelector?.('input[name="destination"]:checked')?.value||null;
  const client=destinations?destinations.find(member=>directClientKey(member)===chosenDestination)||null:picked;
  const scope=form.querySelector('input[name="scope"]:checked')?.value==='project'?'project':'tasks';
  const chosen=scope==='tasks'?[...form.querySelectorAll('input[name="taskId"]')].filter(input=>input.checked).map(input=>input.value):[];
  const taskNames=chosen.map(id=>(tasks.find(task=>task.id===id)||known.find(task=>task.id===id))?.name||'A chosen task');
  const gone=chosen.map((id,index)=>tasks.some(task=>task.id===id)?null:taskNames[index]).filter(Boolean);
  const list=!tasks.length?'nothing':tasks.length>5?`${tasks.length} tasks`:tasks.map(task=>`“${task.name}”`).join(', ');
  const what=scope==='project'?`Whole project ${projectName}. ${fresh?'Published now':'Published when this opened'}: ${list}, and later ones`
    :`${taskNames.length===1?'Task':`${taskNames.length} tasks`} ${taskNames.map(name=>`“${name}”`).join(', ')}`;
  const clientName=client?directClientLabel(client):'';
  const mode=scope==='project'?(form.elements.mode?.value??(entry==='project'?'':'whole')):null;
  let selection=null,selectionError=null;
  if(mode!==null){
    try{selection=readProjectSelection(form,mode,selectionCatalog,{unticked:mode==='except',firstShare:true})}
    catch(error){selectionError=error;}
  }
  const selectionSummary=projectSelectionSummary({selection,clientName,projectName,catalog:selectionCatalog});
  return {client,scope,mode,chosen,what:selectionSummary||what,published:scope==='project'?tasks.map(task=>task.id).sort():chosen,summary:(clientName&&selectionError?.message)
    ||selectionSummary
    ||directScopeSummary({clientName,projectName,scope,taskNames}),
    bodies:({confirmed=false}={})=>{
      if(picked&&!client)throw new Error('Choose the portal account to share with.');
      if(!client)throw new Error('Choose a client.');
      if(selectionError)throw selectionError;
      if(scope==='tasks'&&!chosen.length)throw new Error('Choose at least one task, or share the whole project.');
      // One task that can no longer be shared refuses the whole share, before anything is sent.
      if(gone.length)throw new Error(`${gone.map(name=>name==='A chosen task'?name:`“${name}”`).join(', ')} can no longer be shared. Nothing was sent. Choose again.`);
      // The contract has no project share without later models: the box must be ticked on purpose.
      if(scope==='project'&&!form.elements.includeLater?.checked)throw new Error(selection
        ?'Confirm that the selection also includes matching models published later.':ERRORS.later_required);
      const expires=form.elements.expiresAt.value?new Date(form.elements.expiresAt.value):null;
      if(expires&&!(expires.getTime()>Date.now()))throw new Error(ERRORS.expired_at_invalid);
      const common={sourceId:client.sourceId,workspaceId:client.workspaceId,viewerProjectId:projectId,
        permissions:Object.fromEntries(PERMISSIONS.map(([name])=>[name,form.elements[name].checked])),
        expiresAt:expires?expires.toISOString():null,confirmedScope:confirmed===true,
        // Asks Operations to email the client's current members about this new share, only where the box is shown.
        ...(form.elements.notifyClient?{notifyClient:form.elements.notifyClient.checked===true}:{})};
      return scope==='project'?[{...common,taskId:null,scopeType:'project',includeFuturePublished:true,...(selection?{selection}:{})}]
        :chosen.map(taskId=>({...common,taskId,scopeType:'task',includeFuturePublished:false}));
    }};
}

function savedSelectionSummary(selection,tasks,folders){
  const names=[
    ...selection.folderIds.map(id=>folders.find(folder=>folder.id===id)?.displayName||'Unavailable folder'),
    ...selection.taskIds.map(id=>tasks.find(task=>task.id===id)?.name||'Unavailable task'),
  ].map(name=>`“${name}”`).join(', ');
  return selection.mode==='only'?`Only ${names}`:`Whole project except ${names}`;
}

export function editableDirectProjectGrant(access,projectId,grantId,now=Date.now()){
  if(access?.listedProjectId!==projectId||access.capabilities?.replaces!==true||access.grantsIncomplete||access.grantsNextCursor)return null;
  const grant=access.grants.find(item=>item.grantId===grantId&&item.viewerProjectId===projectId&&!item.revokedAt);
  if(grant?.scopeType!=='project'||grant.taskId!==null||grant.includeFuturePublished!==true
    ||!grant.sourceId||!grant.workspaceId||!Number.isSafeInteger(grant.grantVersion)
    ||grant.grantVersion<1||!(grant.expiresAt===null||Date.parse(grant.expiresAt)>now)
    ||PERMISSIONS.some(([key])=>typeof grant.permissions?.[key]!=='boolean'))return null;
  const other=access.grants.some(item=>!item.revokedAt&&item.grantId!==grantId&&item.viewerProjectId===projectId
    &&item.sourceId===grant.sourceId&&item.workspaceId===grant.workspaceId);
  return other?null:grant;
}

const PROJECT_CHOICES_UNAVAILABLE='Folders and tasks could not be verified. Close and reopen Share to choose a project selection.';
function projectSelectionFields(catalog,selection=null,{editing=false}={}){
  const active=selection?.mode||'whole';
  const choices=[['whole','Everything'],['except','All except'],['only','Only']];
  const options=(name,items,selected=[],labelFor)=>{
    const available=new Set(items.map(item=>item.id));
    return [...items.map(item=>({id:item.id,label:labelFor(item),missing:false})),
      ...selected.filter(id=>!available.has(id)).map(id=>({id,label:`Previously selected ${name} is unavailable`,missing:true}))]
      .map(({id,label,missing})=>`<label class="check"><input name="${name}" type="checkbox" value="${esc(id)}" ${selected.includes(id)?'checked':''} ${missing?'data-missing':''}> ${esc(label)}</label>`).join('');
  };
  const folderOptions=options('folder',catalog?.folders||[],selection?.folderIds,folder=>folder.displayName);
  const taskOptions=options('task',catalog?.tasks||[],selection?.taskIds,task=>task.name);
  return `<label><span>What this client can see</span><select name="mode">
${choices
  .map(([mode,label])=>`<option value="${mode}" ${mode===active?'selected':''}${!catalog&&mode!=='whole'?' disabled':''}>${label}</option>`).join('')}
</select></label>
${catalog?'':`<p class="form-note">${esc(PROJECT_CHOICES_UNAVAILABLE)}</p>`}
<fieldset ${editing?'data-edit-share-targets':'data-direct-share-targets'} ${active==='whole'?'hidden disabled':''}><legend>Folders and tasks</legend>
<div class="direct-share-tasks"><strong>Folders</strong>${folderOptions}
<strong>Tasks</strong>${taskOptions}</div></fieldset>`;
}

function projectSelectionSummary({selection,clientName,projectName,catalog}){
  if(!selection||!clientName)return null;
  return `Authorized members of ${clientName}’s portal account can use this share in ${projectName}. ${savedSelectionSummary(selection,catalog.tasks,catalog.folders)}. This share follows the current folder structure and includes matching tasks published later.`;
}

export function directProjectShareEditForm({grant,tasks,folders}){
  return `<form id="direct-project-share-edit" class="manage-form direct-share-form">
<p>Editing access for <strong>${esc(grant.clientDisplayName||'this client')}</strong></p>
${projectSelectionFields({tasks,folders},grant.selection,{editing:true})}
<p role="status"></p>
<div class="action-row"><button type="submit" class="primary-button">Review change</button>
<button type="button" class="secondary-button" data-edit-share-back>Back to access list</button></div></form>`;
}

// Keep intentional direct choices apart from the inherited ticks painted onto controls.
// Readers use the same derivation as rendering, never disabled as a source of authority.
const firstShareChoices=new WeakMap();
export function syncDirectProjectSelection(form,mode,catalog,{reset=false,render=true}={}){
  if(!catalog)return null;
  const legend=render?form.querySelector('[data-direct-share-targets] legend'):null;
  if(legend)legend.textContent=mode==='except'?'Untick folders and tasks to exclude':mode==='only'?'Tick folders and tasks to include':'Folders and tasks';
  const active=mode==='only'||mode==='except',checked=mode==='only';
  let previous=firstShareChoices.get(form);
  if(reset||previous?.mode!==mode)previous=null;
  const choices=new Map(),groups={};
  for(const name of ['folder','task']){
    const selected=new Set(form.querySelectorAll(`input[name="${name}"]${mode==='except'?':not(:checked)':':checked'}`));
    const inputs=[...new Set([...form.querySelectorAll(`input[name="${name}"]`),...selected])];
    groups[name]=inputs;
    for(const input of inputs){
      const old=previous?.choices.get(input);
      const direct=reset?mode==='except':old?.inherited?old.direct:selected.has(input)===checked;
      choices.set(input,{direct,inherited:false});
    }
  }
  const explicitFolders=new Set(groups.folder.filter(input=>choices.get(input).direct===checked).map(input=>input.value));
  const folders=new Map(catalog.folders.map(folder=>[folder.id,folder]));
  const tasks=new Map(catalog.tasks.map(task=>[task.id,task]));
  const inheritedFrom=id=>{
    while(id){if(explicitFolders.has(id))return id;id=folders.get(id)?.parentId;}
    return null;
  };
  const result={folderIds:[],taskIds:[]};
  for(const name of ['folder','task'])for(const input of groups[name]){
    const choice=choices.get(input),ancestor=active?inheritedFrom(name==='folder'?folders.get(input.value)?.parentId:tasks.get(input.value)?.folderId):null;
    choice.inherited=Boolean(ancestor);
    if(active&&!ancestor&&choice.direct===checked)result[`${name}Ids`].push(input.value);
    if(render){
      input.checked=ancestor?checked:choice.direct;
      input.disabled=Boolean(ancestor);
      input.title=ancestor?`Inherited from ${folders.get(ancestor)?.displayName||'ancestor folder'}. Change that folder to choose this item separately.`:'';
    }
  }
  if(render)firstShareChoices.set(form,{mode,choices});
  return {...result,folderIds:[...new Set(result.folderIds)].sort(),taskIds:[...new Set(result.taskIds)].sort()};
}

function readProjectSelection(form,mode,catalog,{unticked=false,firstShare=false}={}){
  if(mode==='whole')return null;
  if(mode!=='only'&&mode!=='except')throw new Error('Choose what the client can see.');
  if(!catalog)throw new Error(PROJECT_CHOICES_UNAVAILABLE);
  const selected=(name,items)=>{
    const available=new Set(items.map(item=>item.id));
    const inputs=[...form.querySelectorAll(`input[name="${name}"]${unticked?':not(:checked)':':checked'}`)];
    if(inputs.some(input=>!available.has(input.value)||input.hasAttribute('data-missing')))
      throw new Error('Clear unavailable selections and review the updated access.');
    return [...new Set(inputs.map(input=>input.value))].sort();
  };
  let folderIds=selected('folder',catalog.folders),taskIds=selected('task',catalog.tasks);
  if(firstShare)({folderIds,taskIds}=syncDirectProjectSelection(form,mode,catalog,{render:false}));
  const count=folderIds.length+taskIds.length;
  if(count<1||count>128)throw new Error(unticked?'Untick between 1 and 128 folders and tasks to exclude, or choose Everything.':'Choose between 1 and 128 folders and tasks.');
  return {version:1,mode,folderIds,taskIds};
}

export function readDirectProjectShareEdit(form,{grant,projectName,tasks,folders}){
  const mode=form.elements.mode.value,catalog={tasks,folders};
  const selection=readProjectSelection(form,mode,catalog);
  const original=grant.selection;
  const unchanged=selection?original?.mode===mode
    &&JSON.stringify(selection.folderIds)===JSON.stringify(original.folderIds)
    &&JSON.stringify(selection.taskIds)===JSON.stringify(original.taskIds):!original;
  if(unchanged)throw new Error('Choose a different selection to save a change.');
  const clientName=grant.clientDisplayName||'the selected client';
  const summary=projectSelectionSummary({selection,clientName,projectName,catalog})||directScopeSummary({clientName,projectName,scope:'project'});
  return {summary,body:{sourceId:grant.sourceId,workspaceId:grant.workspaceId,viewerProjectId:grant.viewerProjectId,
    taskId:null,scopeType:'project',includeFuturePublished:true,permissions:{...grant.permissions},
    expiresAt:grant.expiresAt,confirmedScope:true,...(selection?{selection}:{}),
    replaces:[{grantId:grant.grantId,grantVersion:grant.grantVersion}]}};
}

export function directGrantRows(access,{projectId,tasks,folders=[],taskId=null,dateTime=value=>value,now=Date.now(),groups=null}){
  const grants=access.grants.filter(grant=>!grant.revokedAt&&grant.viewerProjectId===projectId&&(!taskId||grant.scopeType==='project'||grant.taskId===taskId));
  const known=new Map((access.clientNames||[]).map(client=>[directClientKey(client),client]));
  const groupOf=directClientGroupOf(groups);
  // Grants to linked workspaces of one client read as that one client; revoking still acts on one grant.
  const named=grant=>({...known.get(directClientKey(grant)),sourceId:grant.sourceId,workspaceId:grant.workspaceId,displayName:grant.clientDisplayName,
    groupKey:groupOf(grant)||undefined});
  // The same share in two divisions of one client: those rows say which division each is.
  const twin=grant=>Boolean(groupOf(grant))&&grants.some(other=>other!==grant&&groupOf(other)===groupOf(grant)
    &&other.scopeType===grant.scopeType&&other.taskId===grant.taskId);
  const incomplete=access.grantsIncomplete?'<p class="form-note" role="status">Some shares could not be listed. Close and reopen Share to load the rest.</p>':'';
  if(!grants.length)return incomplete||'<div class="empty-state">No clients have access yet.</div>';
  return `${incomplete}<div class="data-list top-gap">${grants.map(grant=>{
    const what=grant.selection?savedSelectionSummary(grant.selection,tasks,folders)
      :grant.scopeType==='project'?'Whole project, including models published later':`Task: ${tasks.find(task=>task.id===grant.taskId)?.name||'Unavailable task'}`;
    // An expired share gives no access, but it still holds its place until it is revoked.
    const expired=Boolean(grant.expiresAt)&&!(Date.parse(grant.expiresAt)>now);
    const details=[grant.permissions?`Can ${permissionList(grant.permissions)}`:null,
      expired?`Expired${Number.isNaN(Date.parse(grant.expiresAt))?', end date unknown':` ${dateTime(grant.expiresAt)}`}; revoke it to share this again`:grant.expiresAt?`Expires ${dateTime(grant.expiresAt)}`:'No end date'].filter(Boolean).join(' · ');
    const own=named(grant),word=clientPickerWord(own,grants.map(named))
      ||(twin(grant)?clientBusinessWord(own.businessName)||`ref ${String(grant.workspaceId).slice(-6)}`:null);
    const edit=!taskId&&grant.scopeType==='project'&&editableDirectProjectGrant(access,projectId,grant.grantId,now);
    return `<div class="manage-row share-access-row"><div><strong>${esc(grant.clientDisplayName||'Client')}${word?` <span class="client-picker-meta">${esc(word)}</span>`:''}</strong><small>${esc(what)}</small><small>${esc(details)}</small></div><div class="row-actions">${expired?'<span class="status expired">expired</span>':''}${edit?`<button class="secondary-button" data-action="edit-direct-project-share" data-id="${esc(grant.grantId)}">Edit selection</button>`:''}<button class="secondary-button" data-action="revoke-direct-client-grant" data-id="${esc(grant.grantId)}">Revoke</button></div></div>`;
  }).join('')}</div>`;
}

export function publicationFolderPath(task,folders,{projectId,taskId}){
  if(task?.id!==taskId||task.projectId!==projectId||!Object.hasOwn(task,'folderId'))return null;
  if(task.folderId===null)return [];
  if(typeof task.folderId!=='string'||!Array.isArray(folders))return null;
  const parents=new Map(folders.filter(folder=>folder?.projectId===projectId).map(folder=>[folder.id,folder.parentId]));
  const path=[];
  for(let id=task.folderId;id!==null;id=parents.get(id)){
    if(path.length===16||path.includes(id)||!parents.has(id))return null;
    path.push(id);
  }
  return path;
}

function selectionCoversTask(selection,taskId,folderPath){
  if(selection.taskIds.includes(taskId))return selection.mode==='only';
  if(selection.mode==='only'&&!selection.folderIds.length)return false;
  if(folderPath===null)return null;
  const matched=selection.folderIds.some(id=>folderPath.includes(id));
  return selection.mode==='only'?matched:!matched;
}

// A task share can outlive its model, so a task being published again counts too.
export function publishAudience(access,{projectId,taskId,folderPath=null,now=Date.now()}){
  const clients=new Map();
  let complete=true;
  for(const grant of access.grants){
    if(grant.revokedAt||grant.viewerProjectId!==projectId||grant.expiresAt&&!(Date.parse(grant.expiresAt)>now))continue;
    const covered=grant.selection?selectionCoversTask(grant.selection,taskId,folderPath)
      :grant.scopeType==='project'||grant.scopeType==='task'&&grant.taskId===taskId;
    if(covered===null)complete=false;
    if(covered)
      clients.set(directClientKey(grant),{key:directClientKey(grant),name:grant.clientDisplayName||'a client',id:grant.workspaceId});
  }
  return {clients:[...clients.values()],complete};
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
