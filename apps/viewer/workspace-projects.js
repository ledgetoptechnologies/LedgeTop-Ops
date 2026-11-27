import { WorkspaceSessionRenewal, validateWorkspaceSessionEnvelope } from './workspace-renewal.mjs';
import { ReviewSessionController } from './review-session-controller.mjs';
import { createMeasurementCalculationBroker } from './measurement-calculation-broker.mjs';
import { beginIsolatedViewerLaunch } from './isolated-viewer-launch.mjs';
import { formatArea, formatGsd } from './unit-formatters.mjs';
import { fromUrl as openGeoTiff, Pool as GeoTiffPool } from './geotiff-browser.mjs';
import { isRgbNoData, parseFiniteGdalNoData } from './orthophoto-mask.mjs';
import { synchronizeOrthophotoPreviews } from './workspace-orthophoto-preview-state.mjs';
import { createStorageUsagePoll } from './storage-usage-poll.mjs';
import { canRecoverExistingResult, recoverExistingResult } from './workspace-ingest-recovery.mjs';
import { createWorkspaceDialogs } from './workspace-dialogs.mjs';
import { mountPropertyLinesSource } from './workspace-property-lines.mjs';
import { mountNewTask } from './workspace-new-task.mjs';
import { attemptProviderName, removeProcessingProvider } from './workspace-provider-remove.mjs';
import { mountTaskOptions } from './workspace-task-options.mjs';
import { createWorkspaceRecovery, relayWorkspaceRecoveryGrant } from './workspace-recovery.mjs';
import { renderCurrentTabRecoveryOffer } from './workspace-current-tab-recovery-ui.mjs';
import { resumeCurrentTabWorkspaceRecovery } from './workspace-current-tab-recovery.mjs';
import { createWorkspaceNavigationWork, workspaceNavigationState } from './workspace-navigation-state.mjs';
import { WORKSPACE_NAV_GROUPS, installWorkspaceSidebar, renderWorkspaceNav, setWorkspaceHealth } from './workspace-sidebar.mjs';
import { folderAncestry, folderIsEmpty, folderTaskCounts, limitOpenProjects, projectTreeRows, readTreeState, treeKeyAction, writeTreeState } from './workspace-folder-tree.mjs';
const NAV=WORKSPACE_NAV_GROUPS.flatMap(([,items])=>items.map(([id,label])=>[id,'',label]));
import { DIRECT_CLIENT_GRANTS_PATH, SHARE_TARGET_MISSING, bindClientPicker, directClientAccess, directClientsPath, directGrantRows, directShareErrorText, directShareForm, directShareReviewMarkup, loadDirectClientAccess, loadDirectClientGroups, directClientGroupOf, directDestinationMarkup, publishAudience, publishAudienceNames, publishAudienceText, readDirectShareForm, directClientKey, shareableTasks } from './workspace-direct-client-share.mjs';

const dialogs=createWorkspaceDialogs();

function outputDownloadMenu(output){
  if(!output)return toast('This output is no longer available',true);
  const products=Array.isArray(output.downloadProducts)?output.downloadProducts:[];
  openModal(`Download · ${output.displayName||'Task products'}`,`<p class="form-note">Choose a product. Downloads stream directly to your browser; model files are not buffered in Viewer memory.</p><div class="product-download-list">${products.map((product,index)=>`<button class="product-download-item secondary-button" data-product-index="${index}"><span><strong>${esc(product.label)}</strong><small>${esc(product.format)} · ${esc(bytes(product.byteSize))}</small></span><span aria-hidden="true">↓</span></button>`).join('')||empty('No registered downloadable products are available. Refresh the workspace if this model was just prepared.')}<p class="form-note">Only existing registered files are listed. Streaming tile manifests are not original point-cloud files. OBJ geometry does not include its texture dependencies.</p></div>`);
  modalContent.querySelectorAll('[data-product-index]').forEach(element=>element.onclick=async()=>{
    const product=products[Number(element.dataset.productIndex)];
    if(!product?.grantUrl)return;
    element.disabled=true;
    try{await authenticatedDownload(product.grantUrl,product.fileName);toast('Download handed to your browser. Check its Downloads panel for progress.');}
    catch(error){toast(error.message,true)}finally{element.disabled=false}
  });
}

const TOKEN_KEY='ltds-viewer-admin-token';
const OPS_ORIGIN_KEY='ltds-viewer-ops-origin';
const REAUTH_STATE_KEY='ltds-viewer-reauthorization-state';
const WORKSPACE_SECTIONS=new Set(NAV.map(([id])=>id));
const LIVE_ATTEMPT_STATUSES=new Set(['pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting','derivatives']);
const NODE_PROCESSING_STATUSES=new Set(['running']);
const VIEWER_FINALIZATION_STATUSES=new Set(['ingesting','derivatives']);
const VIEWER_SUBMISSION_STATUSES=new Set(['pending','admitted','initializing','uploading','committed']);
const OPERATION_ACTIVE=new Set(['queued','leased','awaiting_derivatives']);
function taskPhaseCounts(tasks){const counts={submitting:0,queued:0,processing:0,finalizing:0};for(const task of tasks){const status=task.latestAttempt?.status;if(VIEWER_SUBMISSION_STATUSES.has(status))counts.submitting++;else if(status==='queued_upstream')counts.queued++;else if(NODE_PROCESSING_STATUSES.has(status))counts.processing++;else if(VIEWER_FINALIZATION_STATUSES.has(status))counts.finalizing++}return counts}
function readWorkspaceView(url=location.href){const parsed=new URL(url,location.origin),section=parsed.searchParams.get('section')||'dashboard',selectedProjectId=parsed.searchParams.get('project'),expandedTaskId=parsed.searchParams.get('task');return{section:WORKSPACE_SECTIONS.has(section)?section:'dashboard',selectedProjectId:selectedProjectId||null,selectedFolderId:parsed.searchParams.get('folder')||null,expandedTaskId:expandedTaskId||null,taskPage:['gcp','settings','files'].includes(parsed.searchParams.get('panel'))?parsed.searchParams.get('panel'):null}}
const initialView=readWorkspaceView();
const state={section:initialView.section,token:sessionStorage.getItem(TOKEN_KEY),adminSession:null,projects:[],datasets:[],tasks:[],providers:[],presets:[],outputs:[],operations:[],derivativeJobs:[],diagnosticRuns:[],diagnosticRunsCursor:null,diagnosticRunsError:null,diagnosticRunsLoading:false,selectedDiagnosticRunId:null,diagnosticDetails:{},shares:{},sharePreflight:{},shareContext:null,projectShares:{},clientAccess:null,clientNativeAccess:null,lastShareUrl:null,storage:null,trashLoadError:null,failedMutations:[],ready:null,busy:false,operationRefreshBusy:false,projectQuery:'',backgroundQuery:'',backgroundImportLimit:3,backgroundDerivativeLimit:3,selectedProjectId:initialView.selectedProjectId,expandedTaskId:initialView.expandedTaskId,taskPage:initialView.taskPage,selectedProviderId:null,taskDetails:{},taskDisclosures:{},orthophotoPreviews:{},gcpWorkspaces:{},logTimer:null,operationTimer:null};
// Folders load per open project, on expand, and never change project authorization.
// folderCache: projectId -> { folders, error, loading }; a newer entry object retires older requests.
const folderCache=new Map();
// The tree: expanded projects and folders per user (localStorage), the roving tab stop,
// an inline "New folder" row or rename, and folder paths to reveal once their folders load.
let treeState={projects:new Set(),folders:new Set()},treeSubject=null,treeCurrentKey=null,treePending=null,treeRenaming=null;
const treeReveals=new Map();
if(initialView.selectedProjectId&&initialView.selectedFolderId)treeReveals.set(initialView.selectedProjectId,initialView.selectedFolderId);
let folderAuthorizationGeneration=0,activeFolderMutation=null;
let projectDataGeneration=0,projectRefreshTimer=null,projectRefreshBusy=false,projectPaintPending=false,workspaceLoads=0;
let projectArtifactsRefreshId=null;
// Projects whose outputs changed here (a public link published a model). A list read that started earlier
// must not put that project's old rows back; everything else in the read still commits.
const outputFences=new Map();
function fencedOutputs(incoming,fences){
  const changed=output=>outputFences.get(output.projectId)!==fences.get(output.projectId);
  return [...incoming.filter(output=>!changed(output)),...state.outputs.filter(changed)];
}
let draggedFolderTask=null,folderUndo=null,folderUndoTimer=null,treeDragHover=null,treeDragExpandTimer=null;
function isProjectOpen(projectId){return state.section==='dashboard'&&Boolean(projectId)&&(projectId===state.selectedProjectId||treeState.projects.has(projectId))}
function openProjectIds(){return state.projects.filter(project=>isProjectOpen(project.id)).map(project=>project.id)}
function loadTreeState(){
  const subject=state.adminSession?.subject||null;
  if(subject===treeSubject)return;
  treeSubject=subject;treeState=readTreeState(globalThis.localStorage,subject);
  if(state.selectedProjectId)touchOpenProject(state.selectedProjectId);
}
// Opening (or re-opening) a project makes it the newest of the open projects.
function touchOpenProject(projectId){treeState.projects.delete(projectId);treeState.projects.add(projectId)}
// Saved only once the signed-in user is known; before that the tree lives in memory. Only the ten
// newest open projects stay open; one dropped here closes on the page at once (the selected
// project and the one a task is being dragged from are kept).
function saveTreeState(){
  const before=[...treeState.projects];
  limitOpenProjects(treeState.projects,[state.selectedProjectId,draggedFolderTask?.projectId]);
  for(const projectId of before)if(!treeState.projects.has(projectId))closeDroppedProject(projectId);
  if(treeSubject)writeTreeState(globalThis.localStorage,treeSubject,treeState);
}
function closeDroppedProject(projectId){
  if(isProjectOpen(projectId))return;
  const section=content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"]`),project=state.projects.find(item=>item.id===projectId);
  if(!section||!project)return;
  const hadFocus=section.contains(document.activeElement);
  section.closest('.project-row')?.classList.remove('selected');
  section.remove();
  syncProjectHead(project);
  if(hadFocus)focusTreeRow(`p:${projectId}`,{scroll:false});
}
function invalidateFolderAuthorization(){
  folderAuthorizationGeneration++;folderCache.clear();
  projectDataGeneration++;
  clearFolderUndo();
  // Keep the expanded tree: expiry recovery restores navigation, not old data.
  if(activeFolderMutation){activeFolderMutation=null;state.busy=false;shell.removeAttribute('aria-busy');}
}
// open:false is for moves and their Undo, which the server checks against the task's revision
// even after the user closed the project in this tab.
function folderAuthorizationGuard(projectId,permission='viewer.projects.read',{open=true}={}){
  const token=state.token,session=state.adminSession,generation=folderAuthorizationGeneration;
  return()=>Boolean(token&&session&&!workspaceAuthorizationClearing&&token===state.token&&session===state.adminSession&&
    generation===folderAuthorizationGeneration&&state.section==='dashboard'&&(!open||isProjectOpen(projectId))&&can(permission));
}
function folderRequestOptions(method,body,receipt){
  const signature=JSON.stringify([method,body]);
  if(receipt.signature!==signature){receipt.signature=signature;receipt.key=crypto.randomUUID();}
  return{method,...(body===undefined?{}:{body}),headers:{'Idempotency-Key':receipt.key}};
}
function repaintFolderAuthorization(){
  const token=state.token,session=state.adminSession,generation=folderAuthorizationGeneration;
  queueMicrotask(()=>{if(token&&session&&state.token===token&&state.adminSession===session&&
    generation===folderAuthorizationGeneration&&!workspaceAuthorizationClearing&&state.section==='dashboard'&&openProjectIds().length)render();});
}
async function mutateFolder(projectId,url,options,message,guard,onSuccess,reload=true){
  if(!guard()||state.busy)return;
  projectDataGeneration++;
  const owned={};activeFolderMutation=owned;state.busy=true;shell.setAttribute('aria-busy','true');
  try{
    const result=await api(url,{...options,recoveryGuard:guard});if(!guard())return;
    onSuccess?.(result);if(message)toast(message);if(reload)await loadProjectFolders(projectId);return result;
  }catch(error){if(guard())toast(error.message,true);}
  finally{if(activeFolderMutation===owned){activeFolderMutation=null;state.busy=false;shell.removeAttribute('aria-busy');}}
}
async function loadProjectFolders(projectId) {
  const authorized=folderAuthorizationGuard(projectId);if(!authorized())return;
  const previous=folderCache.get(projectId),entry={folders:previous?.folders||null,error:null,loading:true};
  folderCache.set(projectId,entry);
  const current = () => authorized() && folderCache.get(projectId) === entry;
  try {
    const response = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/folders`,{recoveryGuard:current});
    if (!current()) return;
    if (!Array.isArray(response.folders)) throw new Error('Invalid folder response.');
    entry.folders = response.folders.filter(folder => folder.projectId === projectId);
    revealTreeFolder(projectId);
  } catch (error) {
    if (!current()) return;
    entry.error = error.message || 'Folders could not be loaded.';
  } finally {
    if (current()) { entry.loading = false; paintProjectTree(projectId); }
  }
}
// Expands the saved path to a folder (an old ?folder= link, the expanded task, or a move's
// destination) once that project's folders are known.
function revealTreeFolder(projectId){
  const folders=folderCache.get(projectId)?.folders;
  if(!treeReveals.has(projectId)||!folders)return false;
  const folderId=treeReveals.get(projectId);treeReveals.delete(projectId);
  const path=folderAncestry(folders,folderId);
  if(!path.length&&folderId)return false;
  touchOpenProject(projectId);path.forEach(id=>treeState.folders.add(id));saveTreeState();
  return true;
}
function folderPath(folders, folderId) {
  const result = [], seen = new Set();
  for (let current = folderId; current && !seen.has(current);) {
    seen.add(current); const folder = folders.find(item => item.id === current);
    if (!folder) break;
    result.unshift(folder); current = folder.parentId;
  }
  return result;
}
const content=document.querySelector('#workspace-content'),shell=document.querySelector('#workspace'),modal=document.querySelector('#workspace-modal'),modalContent=document.querySelector('#workspace-modal-content');
const workspaceController=window.opener&&!window.opener.closed?window.opener:null;
const reviewSessionController=new ReviewSessionController({origin:location.origin,storage:sessionStorage,issueGrant:({sessionMode,attemptId,outputId},{signal}={})=>api(sessionMode==='published'?`/api/v1/processing/outputs/${encodeURIComponent(outputId)}/view-sessions`:`/api/v1/attempts/${encodeURIComponent(attemptId)}/review-sessions`,{method:'POST',body:{},signal}),measurementRequest:createMeasurementCalculationBroker({origin:location.origin,getAuthorization:()=>({accessToken:state.token,session:state.adminSession})})});
let workspaceRenewal=null;
let workspaceAuthorizationClearing=false;
let publicationAuthorityGeneration=0;
const publicationReads=new Set();
const navigationWork=createWorkspaceNavigationWork({windowRef:window});
function currentWorkspaceNavigationState(){return workspaceNavigationState({newTask:activeNewTask?.navigationState,gcpWorkspaces:state.gcpWorkspaces,taskDetails:state.taskDetails,work:navigationWork.snapshot(),legacySelectedFileCount:modalContent.querySelector('#upload-form input[type="file"]')?.files?.length||0});}
const workspaceRecovery=createWorkspaceRecovery({getSession:()=>({session:state.adminSession,accessToken:state.token,controllerOrigin:sessionStorage.getItem(OPS_ORIGIN_KEY)}),getView:workspaceView,getNavigationState:currentWorkspaceNavigationState,onPopupBlocked:({continueInCurrentTab,navigationState})=>renderCurrentTabRecoveryOffer({container:document.querySelector('dialog.workspace-recovery[open]'),navigationState,continueInCurrentTab}),install:installWorkspaceSession,onFatal:()=>{workspaceAuthorizationClearing=false;clearWorkspaceAuthorization('revoked');},onPaused:()=>{invalidatePublicationAuthority();reviewSessionController.suspend({preserve:true});storageUsagePoll.stop();clearInterval(state.logTimer);clearTimeout(state.operationTimer);},onResumed:()=>{workspaceAuthorizationClearing=false;storageUsagePoll.sync();scheduleOperationRefresh();toast('Access restored. Your workspace and upload can continue.');}});
let orthophotoPool=null;
const storageUsagePoll=createStorageUsagePoll({
  shouldPoll:()=>Boolean(state.token&&state.section==='diagnostics'&&!document.hidden&&(state.storage?.usage?.status==='pending'||state.storage?.usage?.refreshing)),
  read:signal=>api('/api/v1/storage?limit=1',{signal}),
  onResult:result=>{state.storage={...state.storage,usage:result.usage};const target=document.getElementById('storage-usage-cards');if(target)target.innerHTML=storageUsageCards(result.usage);},
  onError:message=>{const target=document.getElementById('storage-usage-cards');if(target)target.innerHTML=storageUsageCards(state.storage?.usage)+metric('Storage refresh','Paused',message);},
});
addEventListener('pagehide',()=>storageUsagePoll.stop());
document.addEventListener('visibilitychange',()=>storageUsagePoll.sync());

function canShareOutput(output) {
  const published=output.activePublished&&output.status==='published';
  if(published)return ['viewer.shares.create','viewer.shares.read','viewer.shares.revoke','viewer.client_grants.manage'].some(can);
  return output.status==='ready'&&Boolean(output.attemptId)&&can('viewer.processing.publish')
    &&['viewer.shares.create','viewer.shares.read','viewer.client_grants.manage'].some(can);
}
async function openShareModal(projectId,onlyOutputId=null){
  state.clientNativeAccess=null;state.clientDirectAccess=null;state.clientDirectGroups=new Map();
  // A task's Share stays that task's Share: what it was opened on is fixed now, not looked up again after a refresh.
  const openedTask=onlyOutputId?state.tasks.find(task=>task.id===state.outputs.find(output=>output.id===onlyOutputId)?.taskId):null;
  const context={projectId,onlyOutputId,taskId:openedTask?.id||null,taskName:openedTask?.displayName||'',id:crypto.randomUUID(),mode:'internal',loading:true,clientLoading:can('viewer.client_grants.manage'),clientError:null};
  const token=state.token,subject=state.adminSession?.subject;
  const current=()=>Boolean(token)&&state.shareContext===context&&modal.open&&state.token===token&&state.adminSession?.subject===subject
    &&modalContent.querySelector('.share-columns')?.dataset.shareContext===context.id;
  state.shareContext?.publicationConfirmation?.abort();
  state.shareContext=context;
  const taskIds=new Set(state.tasks.filter(task=>task.projectId===projectId).map(task=>task.id));
  const outputs=state.outputs.filter(output=>taskIds.has(output.taskId)&&(!onlyOutputId||output.id===onlyOutputId)
    &&(output.activePublished||output.status==='ready'));
  shareModal(projectId,onlyOutputId);
  const reads=[];
  if(can('viewer.shares.read'))for(const output of outputs)reads.push((async()=>{
    try{const result=await api(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/shares`);
      if(current()){state.sharePreflight[output.id]={...result,error:null};state.shares[output.id]=result.shares||[];}
    }catch(error){if(current())state.sharePreflight[output.id]={error:error.message};}
  })());
  if(!onlyOutputId&&(can('viewer.shares.read')||can('viewer.shares.revoke')))reads.push((async()=>{
    try{const result=await api(`/api/v1/projects/${encodeURIComponent(projectId)}/public-shares`);if(current())state.projectShares[projectId]=result.shares||[];}
    catch{if(current())state.projectShares[projectId]=[];}
  })());
  // Optional Operations lookup must not hold the independent public-link form.
  // A late result updates only its own panel, preserving typed public-link fields.
  if(context.clientLoading)void(async()=>{
    const [legacy,native]=await Promise.allSettled([api('/api/v1/workspace/client-grants'),api('/api/v1/workspace/native-client-grants')]);
    if(!current()||!can('viewer.client_grants.manage'))return;
    state.clientAccess=legacy.status==='fulfilled'?legacy.value:null;
    state.clientNativeAccess=native.status==='fulfilled'&&Array.isArray(native.value?.targets)&&Array.isArray(native.value?.grants)?native.value:null;
    context.clientLoading=false;context.clientError=legacy.status==='rejected'?clientAccessDiagnostic(legacy.reason):null;context.nativeError=native.status==='rejected'?clientAccessDiagnostic(native.reason):null;
    if(context.loading)return;
    const legacyPanel=modalContent.querySelector('[data-legacy-client-share-panel]');
    if(state.clientDirectAccess&&legacyPanel){legacyPanel.innerHTML=legacyClientSharePanel(state.outputs.find(output=>output.id===onlyOutputId),onlyOutputId);bindShareModal(projectId,onlyOutputId,{preserveDirectForm:true});return;}
    const panel=modalContent.querySelector('[data-client-share-panel]');
    if(panel){panel.innerHTML=clientSharePanel(state.outputs.find(output=>output.id===onlyOutputId),onlyOutputId);bindShareModal(projectId,onlyOutputId);}
  })();
  // Direct sharing has its own authority and must not wait for project lookups.
  if(context.clientLoading)void(async()=>{
    // One grouping read per open, alongside the access list. The client panel waits for both (grouping gives up
    // after a short wait), so the picker's grouping is fixed before any row is shown and never changes after.
    const grouping=loadDirectClientGroups(api).catch(()=>new Map());
    let access=null;
    try{access=await loadDirectClientAccess(api,projectId);}catch{}
    const groups=await grouping;
    if(!current()||!can('viewer.client_grants.manage'))return;
    state.clientDirectAccess=access;state.clientDirectGroups=groups;context.directQuery='';
    if(context.loading)return;
    const panel=modalContent.querySelector('[data-client-share-panel]');
    if(panel){panel.innerHTML=clientSharePanel(state.outputs.find(output=>output.id===onlyOutputId),onlyOutputId);bindShareModal(projectId,onlyOutputId);}
  })();
  await Promise.all(reads);
  context.loading=false;
  if(!token||!current())return;
  shareModal(projectId,onlyOutputId);
  if(!onlyOutputId)injectProjectShareCard(projectId);
}
function injectProjectShareCard(projectId){
  const target=modalContent.querySelector('[data-legacy-project-shares]');if(!target)return;
  const shares=state.projectShares[projectId]||[],tab=modalContent.querySelector('#share-tab-public');
  if(tab)tab.textContent=publicTabLabel(shares);
  target.innerHTML=shares.length?card('Existing public project links',`<p class="form-note">New project links cannot be created. A link marked active opens the project until it expires or you revoke it.</p><div class="data-list">${shares.map(share=>`<div class="manage-row"><div><strong>${esc(share.label||'Whole-project link')}</strong><small>${share.hasPassword?'Password protected':'No password'} · ${share.accessCount||0} views · ${share.expiresAt&&Number.isNaN(Date.parse(share.expiresAt))?(publicLinkState(share)==='expired'?'Expired, end date unknown':'End date unknown'):publicLinkState(share)==='expired'?`Expired ${esc(dateTime(share.expiresAt))}`:share.expiresAt?`Expires ${esc(dateTime(share.expiresAt))}`:'No expiry'}</small></div>${badge(publicLinkState(share))}<div>${!share.revokedAt&&can('viewer.shares.revoke')?button('revoke-project-share',share.id,'Revoke'):''}</div></div>`).join('')}</div>`):'';
  bindProjectShareCard(projectId);
}
function bindProjectShareCard(projectId){
  modalContent.querySelectorAll('[data-action="revoke-project-share"]').forEach(element=>element.onclick=async()=>{
    if(!can('viewer.shares.revoke')||!await dialogs.confirm('Revoke this whole-project public link?',{title:'Revoke project link',submitLabel:'Revoke link',destructive:true})||!element.isConnected||!modal.open)return;
    element.disabled=true;
    try{await api(`/api/v1/project-shares/${encodeURIComponent(element.dataset.id)}`,{method:'DELETE',body:{}});clearShareResult(element.dataset.id,'project');const share=(state.projectShares[projectId]||[]).find(item=>item.id===element.dataset.id);if(share)share.revokedAt=new Date().toISOString();if(element.isConnected&&modal.open)injectProjectShareCard(projectId);toast('Whole-project link revoked')}
    catch(error){toast(error.message,true);element.disabled=false}
  });
}

const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const badge=value=>`<span class="status ${esc(value)}">${esc(String(value||'unknown').replaceAll('_',' '))}</span>`;
const bytes=value=>{const number=Number(value);if(!Number.isFinite(number))return'Unavailable';if(!number)return'0 B';const units=['B','KB','MB','GB','TB'],index=Math.min(Math.floor(Math.log(number)/Math.log(1024)),4);return`${(number/1024**index).toFixed(index>1?1:0)} ${units[index]}`};
const finiteStorageNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
function storageSpaceMetrics(item={}){const total=finiteStorageNumber(item.total),available=finiteStorageNumber(item.available)??finiteStorageNumber(item.availableBytes),derived=total!==undefined&&available!==undefined&&available<=total?total-available:undefined;return{usedBytes:derived??finiteStorageNumber(item.usedBytes),availableBytes:available}}
function storageUsageCards(usage){
  if(!usage||usage.status==='pending')return metric('Viewer file usage','Measuring…','Read-only measurement runs in the background. Refresh shortly.');
  if(usage.status==='error'||!usage.categories)return metric('Viewer file usage','Unavailable','Storage measurement failed; no zero usage is inferred.');
  const qualifier=usage.status==='partial'?'Partial lower bound':usage.stale?'Stale measurement':'Measured files';
  const stamp=`${qualifier} · ${dateTime(usage.measuredAt)}${usage.refreshing?' · refreshing':''}`;
  const rows=[metric('Total Viewer files',bytes(usage.totalBytes),stamp)];
  for(const[key,label]of [['sources','Original photos & source inputs'],['products','Model products'],['cache','Temporary cache & import ZIPs'],['trash','Recycle Bin files'],['other','Other retained files']])rows.push(metric(label,bytes(usage.categories[key]?.bytes),usage.status==='partial'?'Partial measurement':`${usage.categories[key]?.files??0} unique files`));
  for(const[index,space]of (usage.filesystems||[]).entries())rows.push(metric(`Shared filesystem ${index+1}`,`${bytes(space.availableBytes)} free`,`Capacity ${bytes(space.totalBytes)} · ${space.roots.join(', ')} · not a folder subtotal`));
  rows.push(metric('Accounting','Storage roots only','Categories do not overlap. Excludes database/WAL outside these roots, external references, snapshots and filesystem overhead. Compression differs from TrueNAS.'));
  if(usage.errors?.length)rows.push(metric('Measurement warnings',String(usage.errors.length),usage.errors.map(item=>`${item.root||'measurement'}: ${item.code}`).join(' · ')));
  return rows.join('');
}
const dateTime=value=>value?new Date(value).toLocaleString():'Unavailable';
// Runtime rule for every runtime display (task row, task settings, processing history): the engine's own elapsed time for this attempt wins; without one, use the attempt's startedAt to upstreamCompletedAt; otherwise Unavailable.
const duration=(attempt,metrics=attempt)=>{if(!attempt?.id)return'Unavailable';const engineMs=metrics?.processingDurationAttemptId===attempt.id?metrics.processingDurationMs:null;if(Number.isSafeInteger(engineMs)&&engineMs>=0)return durationFromMs(engineMs);const stamp=value=>typeof value==='string'&&value?Date.parse(value):NaN,start=stamp(attempt.startedAt),end=stamp(attempt.upstreamCompletedAt);return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?durationFromMs(end-start):'Unavailable'};
const available=value=>value===undefined||value===null||value===''?'Unavailable':esc(value);
const opts=(items,label='Select')=>`<option value="">${esc(label)}</option>${items.map(item=>`<option value="${esc(item.id)}">${esc(item.displayName||item.name||item.id)}</option>`).join('')}`;
const empty=message=>`<div class="empty-state">${esc(message)}</div>`;
const field=(label,name,attributes='')=>`<label><span>${esc(label)}</span><input name="${esc(name)}" ${attributes}></label>`;
const select=(label,name,options)=>`<label><span>${esc(label)}</span><select name="${esc(name)}" required>${options}</select></label>`;
const button=(action,id,label,primary=false,extra='')=>`<button class="${primary?'primary':'secondary'}-button" data-action="${esc(action)}" data-id="${esc(id)}" ${extra}>${esc(label)}</button>`;
const dangerButton=(action,id,label,extra='')=>`<button class="secondary-button danger-button" data-action="${esc(action)}" data-id="${esc(id)}" ${extra}>${esc(label)}</button>`;
const card=(title,body,action='')=>`<article class="content-card"><div class="card-heading"><h2>${esc(title)}</h2>${action}</div>${body}</article>`;
const values=form=>Object.fromEntries(new FormData(form).entries());
const safeFileName=value=>String(value||'processing-output').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,160)||'processing-output';
const can=permission=>Boolean(state.adminSession?.permissions?.includes(permission));
const groupedNumber=value=>{const number=Number(value);return Number.isFinite(number)?number.toLocaleString('en-US'):'Unavailable'};
const purgeDate=days=>new Date(Date.now()+days*86400_000).toLocaleString();

function toast(message,bad=false,action=null){const element=document.querySelector('#workspace-toast');element.replaceChildren(document.createTextNode(message));element.className=bad?'bad':'';if(action){const link=document.createElement('button');link.type='button';link.className='toast-action';link.textContent=action.label;link.onclick=()=>{element.style.display='none';action.run()};element.append(link)}element.style.display='flex';clearTimeout(toast.timer);toast.timer=setTimeout(()=>element.style.display='none',action?8000:4000)}
function workspaceView(){return{section:state.section,selectedProjectId:state.section==='dashboard'?state.selectedProjectId:null,expandedTaskId:state.section==='dashboard'?state.expandedTaskId:null,taskPage:state.section==='dashboard'&&state.expandedTaskId?state.taskPage:null}}
// Folders are expanded in place (saved per user), so the URL names the project and task only.
function workspaceUrl(view=workspaceView()){const params=new URLSearchParams({section:WORKSPACE_SECTIONS.has(view.section)?view.section:'dashboard'});if(view.section==='dashboard'&&view.selectedProjectId)params.set('project',view.selectedProjectId);if(view.section==='dashboard'&&view.selectedProjectId&&view.expandedTaskId)params.set('task',view.expandedTaskId);if(view.section==='dashboard'&&view.selectedProjectId&&view.expandedTaskId&&['gcp','settings','files'].includes(view.taskPage))params.set('panel',view.taskPage);return`/workspace?${params}`}
function applyWorkspaceView(view){
  const nextSection=WORKSPACE_SECTIONS.has(view?.section)?view.section:'dashboard',nextProject=nextSection==='dashboard'&&view?.selectedProjectId?view.selectedProjectId:null;
  if(state.section!==nextSection||state.selectedProjectId!==nextProject)projectDataGeneration++;
  state.section=nextSection;state.selectedProjectId=nextProject;
  if(nextProject){
    // A project in the URL is open in the tree; an old ?folder= link opens that folder's path.
    touchOpenProject(nextProject);saveTreeState();
    if(view?.selectedFolderId)treeReveals.set(nextProject,view.selectedFolderId);
  }
  state.expandedTaskId=state.selectedProjectId&&view?.expandedTaskId?view.expandedTaskId:null;
  const task=state.tasks.find(item=>item.id===state.expandedTaskId&&item.projectId===state.selectedProjectId);
  if(task?.folderId)treeReveals.set(task.projectId,task.folderId);
  if(state.selectedProjectId)revealTreeFolder(state.selectedProjectId);
  state.taskPage=state.expandedTaskId&&['gcp','settings','files'].includes(view?.taskPage)?view.taskPage:null;
}
function validateWorkspaceView(){if(state.section!=='dashboard'){state.selectedProjectId=null;state.expandedTaskId=null;state.taskPage=null;return}const project=state.projects.find(item=>item.id===state.selectedProjectId);if(!project){state.selectedProjectId=null;state.expandedTaskId=null;state.taskPage=null;return}if(!state.tasks.some(task=>task.id===state.expandedTaskId&&task.projectId===project.id)){state.expandedTaskId=null;state.taskPage=null}}
function syncWorkspaceView(mode='replace'){history[mode==='push'?'pushState':'replaceState'](null,'',workspaceUrl())}
function navigateWorkspace(view,mode='push'){releaseAllGcpImages();applyWorkspaceView(view);validateWorkspaceView();syncWorkspaceView(mode);shell.classList.remove('nav-open');document.querySelector('#nav-toggle')?.setAttribute('aria-expanded','false');render();hydrateExpandedTask()}
function hydrateExpandedTask(){const taskId=state.expandedTaskId;if(!taskId||state.taskDetails[taskId])return;state.taskDetails[taskId]={loading:true};render();void refreshTaskDetails(taskId)}
function responseError(message,status){const error=Error(message);error.status=status;return error}
function clientAccessDiagnostic(error){
  const codes=['authentication_required','permission_denied','invalid_workspace_subject','operations_request_failed','operations_unavailable'];
  return{status:Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:null,
    code:codes.includes(error?.code)?error.code:null,
    requestId:typeof error?.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(error.requestId)?error.requestId:null};
}
function validOpsOrigin(value){try{const parsed=new URL(value);return parsed.protocol==='https:'&&parsed.origin===value&&parsed.pathname==='/'&&!parsed.search&&!parsed.hash?value:null}catch{return null}}
function invalidatePublicationAuthority(){
  publicationAuthorityGeneration++;
  for(const controller of publicationReads)controller.abort();
  state.shareContext?.publicationConfirmation?.abort();
}
function publicationAuthorityLive(){
  return Boolean(state.token&&state.adminSession&&!workspaceAuthorizationClearing&&!workspaceRecovery.isPaused()
    &&!workspaceRenewal?.paused&&Date.parse(state.adminSession.expiresAt)>Date.now());
}
function beginWorkspaceReauthorization(){if(!state.adminSession||!state.token||!validOpsOrigin(sessionStorage.getItem(OPS_ORIGIN_KEY)))return false;void workspaceRecovery.pause();return true}
function clearWorkspaceAuthorization(reason='unauthorized'){if(workspaceAuthorizationClearing)return;workspaceAuthorizationClearing=true;invalidatePublicationAuthority();invalidateFolderAuthorization();const expired=reason==='expired'||(reason==='unauthorized'&&Date.parse(state.adminSession?.expiresAt||'')<=Date.now());workspaceRenewal?.dispose();workspaceRenewal=null;if(expired&&beginWorkspaceReauthorization())return;activeNewTask?.dispose();reviewSessionController.suspend({preserve:false});storageUsagePoll.stop();releaseAllGcpImages();sessionStorage.removeItem(TOKEN_KEY);state.token=null;state.adminSession=null;state.pendingOutputShares?.clear();state.clientAccess=null;state.clientNativeAccess=null;clearInterval(state.logTimer);clearTimeout(state.operationTimer);renderNav();access()}
async function workspaceFetch(path,init={},beforeDispatch){
  await workspaceRecovery.wait(init.signal);
  if(workspaceRenewal&&workspaceRenewal.expiresAtMs<=Date.now()){
    const renewed=await workspaceRenewal.waitForRenewal({signal:init.signal,whileExpired:true});
    if(init.signal?.aborted)throw init.signal.reason||new DOMException('Aborted','AbortError');
    if(!renewed)throw responseError('authorization_required',401);
  }
  let requestToken,requestSession;
  const dispatch=()=>{
    requestToken=state.token;requestSession=state.adminSession;
    return fetch(path,{...init,headers:{...init.headers,Authorization:`Bearer ${requestToken}`}});
  };
  if(beforeDispatch)(await beforeDispatch())();
  let response=await dispatch();
  const isRecordedReceipt=response=>(Boolean(beforeDispatch)||init.headers?.['X-Viewer-Share-Receipt-Only']==='true')
    &&(response.headers?.get('Idempotency-Replayed')==='true'||response.headers?.get('X-Viewer-Share-Receipt-Recorded')==='true');
  if(response.status!==401||isRecordedReceipt(response))return response;
  // Renewal retains the bearer but replaces the authenticated session envelope.
  // A response from before that renewal must not revoke the newer authority.
  if(requestToken===state.token&&requestSession===state.adminSession){
    await workspaceRenewal?.waitForRenewal({signal:init.signal,whileExpired:true});
    if(init.signal?.aborted)throw init.signal.reason||new DOMException('Aborted','AbortError');
    if(requestToken===state.token&&requestSession===state.adminSession){
      clearWorkspaceAuthorization();
      if(!workspaceRecovery.isPaused())return response;
      await workspaceRecovery.wait(init.signal);
    }else if(!state.token||!state.adminSession)return response;
  }else if(!state.token||!state.adminSession)return response;
  if(beforeDispatch)(await beforeDispatch())();
  response=await dispatch();
  if(response.status===401&&!isRecordedReceipt(response)){
    if(requestToken!==state.token||requestSession!==state.adminSession){
      // Bounded replay: never loop through repeated renewals, and do not return
      // a stale401 to api(), which would clear the latest valid workspace.
      throw responseError('Access changed while this request was running. Please retry.',409);
    }
    clearWorkspaceAuthorization('revoked');
  }
  return response;
}
async function api(path,{method='GET',body,headers={},signal,recoveryGuard,beforeDispatch}={}){
  const init={method,...(signal?{signal}:{}),headers:{Authorization:`Bearer ${state.token}`,Accept:'application/json',...headers}};
  if(method!=='GET'&&!init.headers['Idempotency-Key'])init.headers['Idempotency-Key']=crypto.randomUUID();
  if(body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body)}
  const assertRequestCurrent=()=>{
    if(recoveryGuard&&!recoveryGuard())throw Object.assign(Error('Recovery session changed; review the existing request before trying again.'),{code:'recovery_session_changed'});
  };
  let response;
  if(recoveryGuard){
    assertRequestCurrent();
    response=await fetch(path,init);
    assertRequestCurrent();
  }else response=await workspaceFetch(path,init,beforeDispatch);
  let payload;
  try{payload=await response.json()}catch{}
  assertRequestCurrent();
  if(['/api/v1/workspace/client-grants','/api/v1/workspace/native-client-grants'].includes(path)&&!response.ok){
    if(response.status===401)clearWorkspaceAuthorization();
    throw Object.assign(responseError('Operations client access request failed',response.status),
      clientAccessDiagnostic({status:response.status,code:payload?.code,requestId:response.headers?.get('X-LTDS-Client-Access-Request')}));
  }
  const shareRequest=Boolean(beforeDispatch)||init.headers['X-Viewer-Share-Receipt-Only']==='true';
  const receiptReplayed=shareRequest&&response.headers?.get('Idempotency-Replayed')==='true';
  const receiptRecorded=shareRequest&&response.headers?.get('X-Viewer-Share-Receipt-Recorded')==='true';
  if(!response.ok&&(receiptReplayed||receiptRecorded)){
    if(typeof payload?.code!=='string'||!payload.code)
      throw new Error('The link request outcome could not be read. Retry to check it.');
    throw Object.assign(responseError(payload.message||payload.error||'The earlier share request was refused.',response.status),
      {code:payload.code,receiptReplayed,receiptRecorded:true});
  }
  if(response.status===401){clearWorkspaceAuthorization();throw responseError('authorization_required',401)}
  if(response.status===403)throw responseError('Your current Viewer grant does not permit this action',403);
  if(!response.ok)throw Object.assign(responseError(payload?.message||payload?.error||`Request failed (${response.status})`,response.status),
    payload?.code?{code:payload.code,grantId:payload.grantId}:{});
  if(beforeDispatch&&response.status!==201)throw new Error('The link request outcome could not be read. Retry to check it.');
  return receiptReplayed?{...payload,receiptReplayed:true}:payload;
}
async function authenticatedDownload(path,fileName){const grantPath=path.endsWith('/download-grants')?path:path.replace(/\/assets\/([^/]+)$/, '/products/$1/download-grants');if(grantPath===path&&!path.endsWith('/download-grants'))throw new Error('This product does not support a secure download');const response=await workspaceFetch(grantPath,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},body:'{}'});if(response.status===401){clearWorkspaceAuthorization();throw responseError('authorization_required',401)}if(response.status===403)throw responseError('Your current Viewer grant does not permit this download',403);if(!response.ok)throw responseError(`Download failed (${response.status})`,response.status);const grant=await response.json(),url=new URL(grant.url,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith('/api/v1/processing/product-downloads/'))throw new Error('Invalid download response');const link=document.createElement('a');try{link.href=url.href;link.download=grant.fileName||fileName;link.referrerPolicy='no-referrer';document.body.append(link);link.click()}finally{link.remove()}}
async function mutate(path,options,message,onFailure){if(state.busy)return;state.busy=true;shell.setAttribute('aria-busy','true');let submitted=false;try{const result=await api(path,options);submitted=true;toast(typeof message==='function'?message(result):message);await load();return result}catch(error){onFailure?.(error,{submitted});toast(error.message,true)}finally{state.busy=false;shell.removeAttribute('aria-busy')}}
async function confirmedMutation(promptText,path,options,message){if(!await dialogs.confirm(promptText))return;return mutate(path,options,message)}
async function trashMutation(promptText,path,message){if(state.busy||!await dialogs.confirm(promptText,{title:'Move to Recycle Bin',submitLabel:'Move to Recycle Bin',destructive:true})||state.busy)return;state.busy=true;shell.setAttribute('aria-busy','true');try{const result=await api(path,{method:'DELETE',body:{}});await load();toast(message,false,{label:'View Recycle Bin',run:()=>navigateWorkspace({section:'trash'},'push')});return result}catch(error){toast(error.message,true)}finally{state.busy=false;shell.removeAttribute('aria-busy')}}
function consumeReauthorizationState(){const value=new URLSearchParams(location.hash.slice(1)).get('reauthorize');if(!value)return true;let pending=null;try{pending=JSON.parse(sessionStorage.getItem(REAUTH_STATE_KEY)||'null')}catch{}sessionStorage.removeItem(REAUTH_STATE_KEY);const valid=/^[A-Za-z0-9_-]{32,128}$/.test(value)&&pending?.nonce===value&&Number.isFinite(pending?.createdAt)&&Date.now()-pending.createdAt>=0&&Date.now()-pending.createdAt<=5*60*1000;if(valid&&pending?.view)applyWorkspaceView(pending.view);return valid}
function installWorkspaceSession(envelope){invalidatePublicationAuthority();const checked=validateWorkspaceSessionEnvelope({...envelope,accessToken:envelope.accessToken||state.token});if(envelope.accessToken){state.token=envelope.accessToken;sessionStorage.setItem(TOKEN_KEY,state.token)}sessionStorage.setItem(OPS_ORIGIN_KEY,checked.controllerOrigin);workspaceAuthorizationClearing=false;invalidateFolderAuthorization();state.adminSession=checked.session;reviewSessionController.setAuthenticatedSubject(checked.session.subject);workspaceRenewal?.dispose();workspaceRenewal=new WorkspaceSessionRenewal({controllerWindow:workspaceController,envelope,accessToken:state.token,onSession:value=>{invalidateFolderAuthorization();state.adminSession=value.session;if(!can('viewer.client_grants.manage'))invalidatePublicationAuthority();repaintFolderAuthorization()},onExpired:clearWorkspaceAuthorization,onPaused:()=>{invalidatePublicationAuthority();reviewSessionController.suspend({preserve:true});storageUsagePoll.stop();clearInterval(state.logTimer);clearTimeout(state.operationTimer);},onResumed:()=>{reviewSessionController.setAuthenticatedSubject(state.adminSession.subject);storageUsagePoll.sync();scheduleOperationRefresh();if(state.expandedTaskId){const task=state.tasks.find(item=>item.id===state.expandedTaskId);if(LIVE_ATTEMPT_STATUSES.has(task?.latestAttempt?.status))state.logTimer=setInterval(()=>refreshTaskDetails(task.id,true),5000);}}});workspaceRenewal.start()}
async function redeemGrant(){const parts=location.pathname.split('/').filter(Boolean),grant=parts[0]==='workspace'&&parts[1]&&parts[1]!=='active'?decodeURIComponent(parts[1]):null;if(!grant)return false;if(!consumeReauthorizationState())throw responseError('invalid reauthorization state',400);const response=await fetch('/api/v1/admin-sessions/redeem',{method:'POST',headers:{'Content-Type':'application/json',...(state.token?{Authorization:`Bearer ${state.token}`}:{})},body:JSON.stringify({grant})});let body;try{body=await response.json()}catch{body={}}if(response.status===401){clearWorkspaceAuthorization('unauthorized');throw responseError('authorization_required',401)}if(!response.ok)throw responseError(body.error||`Grant redemption failed (${response.status})`,response.status);installWorkspaceSession(body);syncWorkspaceView('replace');return true}
async function restoreWorkspaceSession(){if(!state.token)return false;const response=await fetch('/api/v1/admin-sessions/current',{headers:{Authorization:`Bearer ${state.token}`,Accept:'application/json'}});let body;try{body=await response.json()}catch{body={}}if(response.status===401){clearWorkspaceAuthorization();throw responseError('authorization_required',401)}if(!response.ok)throw responseError(body.error||`Session check failed (${response.status})`,response.status);installWorkspaceSession(body);return true}

function renderNav(){renderWorkspaceNav({shell,container:document.querySelector('#workspace-navigation'),collapseButton:document.querySelector('#nav-collapse'),section:state.section,onSelect:section=>navigateWorkspace({section},'push')})}
function metric(label,value,description){return`<article class="metric-card"><p>${esc(label)}</p><strong>${available(value)}</strong><small>${esc(description)}</small></article>`}
function openModal(title,body,className=''){modal.className=`workspace-modal ${className}`;modalContent.innerHTML=`<div class="modal-heading"><div><p class="eyebrow">Viewer workspace</p><h2 id="workspace-modal-title">${esc(title)}</h2></div><button class="icon-button modal-close" aria-label="Close dialog">×</button></div>${body}`;modalContent.querySelector('.modal-close').onclick=()=>modal.close();modal.showModal()}

function operationSource(operation){const source=operation.source||{},kind=typeof source==='string'?source:source.kind,label=({server_zip:'Server ZIP',server_folder:'Server folder',browser_upload:'Browser upload',server_mount:'Server import folder',existing_model:'Existing model'})[kind]||'Managed import';if(typeof source!=='object'||source===null)return label;if(source.browserTransferRequired&&!source.transferComplete)return`${label} · transfer pending`;if(source.browserTransferRequired&&source.transferComplete)return`${label} · transfer complete`;return label}
function operationTitle(operation){const project=state.projects.find(item=>item.id===operation.projectId),fallback=operation.type==='raw_photo_copy'?'Copy source photos':isCompanionRepairOperation(operation)?'Restore missing products':operation.type==='lod_recovery'?'3D tile recovery version':'Background import',name=operation.result?.task?.displayName||operation.result?.displayName||fallback;return project?`${project.displayName} · ${name}`:name}
function operationProgress(operation){const value=Number(operation.progress),percent=Math.max(0,Math.min(100,Math.round((Number.isFinite(value)?value:0)*100))),phaseLabels={existing_model:'Existing model',validating_source:'Validating recovery source',materializing_recovery:'Creating recovery version'},knownPhases=new Set(['queued','leased','assembling_upload','extracting','staging','discovering','adopting','registering','inspecting','existing_model','validating_source','materializing_recovery','awaiting_derivatives','succeeded','failed','cancelled']),raw=String(operation.phase||operation.status||'queued'),phase=phaseLabels[raw]||(knownPhases.has(raw)?raw:operation.status||'working').replaceAll('_',' '),heartbeat=operation.status==='awaiting_derivatives'?'Waiting for required derivatives':operation.heartbeatAt?`Worker heartbeat ${dateTime(operation.heartbeatAt)}`:OPERATION_ACTIVE.has(operation.status)?'Waiting for worker heartbeat':`Updated ${dateTime(operation.updatedAt)}`;return{percent,phase,heartbeat}}
function backgroundMatches(values){const query=state.backgroundQuery.trim().toLocaleLowerCase('en-US');return!query||values.some(value=>String(value??'').toLocaleLowerCase('en-US').includes(query))}
function backgroundControls(kind,shown,total){if(total<=shown)return'';return`<div class="row-actions background-list-actions">${button('load-more-background',kind,`Load ${Math.min(3,total-shown)} more`,false,`data-kind="${esc(kind)}"`)}${button('view-all-background',kind,`View all ${total}`,false,`data-kind="${esc(kind)}"`)}</div>`}
function operationActivity(){const all=[...state.operations].sort((left,right)=>Date.parse(right.updatedAt||right.createdAt||0)-Date.parse(left.updatedAt||left.createdAt||0)),matching=all.filter(operation=>backgroundMatches([operationTitle(operation),operationSource(operation),operation.status,operation.phase,operation.errorCode])),operations=matching.slice(0,state.backgroundImportLimit),active=all.filter(operation=>OPERATION_ACTIVE.has(operation.status)).length;return`<section id="import-activity" class="import-activity content-card" aria-labelledby="import-activity-title"><div class="card-heading"><div><p class="eyebrow">Background work</p><h2 id="import-activity-title">Import activity</h2></div>${active?badge(`${active} active`):'<small>Newest imports and recoveries</small>'}</div><div class="operation-list" aria-live="polite">${operations.map(operation=>{const progress=operationProgress(operation),failed=operation.status==='failed',recovery=['lod_recovery','companion_repair'].includes(operation.type),canRetry=operation.retryable!==false&&(recovery?can('viewer.processing.write'):can('viewer.datasets.import'));return`<article class="operation-row" data-operation-id="${esc(operation.id)}"><div class="operation-heading"><div><strong>${esc(operationTitle(operation))}</strong><small>Source: ${esc(operationSource(operation))}</small></div>${badge(operation.status)}</div><div class="operation-progress"><progress value="${progress.percent}" max="100" aria-label="${esc(operationTitle(operation))} progress"></progress><strong>${progress.percent}%</strong></div><div class="operation-meta"><span>Phase: ${esc(progress.phase)}</span><span>${esc(progress.heartbeat)}</span><span>Attempt ${Math.max(1,Number(operation.attemptCount)||1)}</span></div>${failed?`<div class="operation-failure"><p>${esc(operation.errorMessage||operation.errorCode||(recovery?'The recovery failed. The existing model version remains safe.':'The import failed without additional details.'))}</p>${canRetry?button('retry-operation',operation.id,recovery?'Retry recovery':'Retry import'):''}</div>`:''}</article>`}).join('')||empty(state.backgroundQuery?'No imports or recoveries match this search.':'No imports or recoveries have been recorded yet.')}</div>${backgroundControls('imports',operations.length,matching.length)}</section>`}
function bindOperationActivity(root=content){root.querySelectorAll('[data-action="retry-operation"]').forEach(element=>element.onclick=()=>action(element))}
function derivativeLabel(job){return job.type==='lod_audit'?'Validate imported 3D tiles':job.type==='mesh_tiles'?'Generate streaming 3D tiles':'Generate point-cloud index'}
function derivativeActivity(){const all=[...state.derivativeJobs].sort((left,right)=>Date.parse(right.updatedAt||right.createdAt||0)-Date.parse(left.updatedAt||left.createdAt||0)),matching=all.filter(job=>backgroundMatches([job.projectDisplayName,job.taskDisplayName,derivativeLabel(job),job.status,job.result?.code,job.result?.phase,job.result?.summary])),jobs=matching.slice(0,state.backgroundDerivativeLimit);return card('Model derivatives',`<div class="operation-list" aria-live="polite">${jobs.map(job=>{const label=derivativeLabel(job),failed=job.status==='failed',running=job.status==='leased',complete=job.status==='complete',fallback=complete&&job.result?.verified===false,percent=complete||failed?100:0,heartbeat=job.heartbeatAt?`Worker heartbeat ${dateTime(job.heartbeatAt)}`:running?'Waiting for worker heartbeat':job.status==='pending'?'Waiting for derivative worker':`Finished ${dateTime(job.completedAt||job.updatedAt)}`,phaseSummary=job.result?.summary,retryable=job.optional&&(Number(job.manualRetryCount)||0)<1&&can('viewer.processing.write');return`<article class="operation-row" data-derivative-id="${esc(job.id)}"><div class="operation-heading"><div><strong>${esc(job.projectDisplayName)} · ${esc(job.taskDisplayName)}</strong><small>${esc(label)}</small></div>${badge(fallback?'fallback':running?'running':job.status)}</div><div class="operation-progress"><progress ${running?'':`value="${percent}"`} max="100" aria-label="${esc(label)} progress"></progress><strong>${running?'Running':job.status==='pending'?'Queued':fallback?'Download available':complete?'Complete':'Failed'}</strong></div><div class="operation-meta"><span>${esc(heartbeat)}</span><span>Started ${dateTime(job.createdAt)}</span>${phaseSummary?`<span>${esc(phaseSummary)}</span>`:''}</div>${failed||fallback?`<div class="operation-failure"><p>${esc(fallback?'Streaming tiles did not verify. The original mesh remains available as an authenticated download.':job.result?.error||'The derivative failed. The original input remains available for recovery.')}</p>${retryable?button('retry-derivative',job.id,job.type==='ept'?'Retry point-cloud indexing':'Retry tile generation'):''}</div>`:''}</article>`}).join('')||empty(state.backgroundQuery?'No derivatives match this search.':'No derivative jobs have been recorded yet.')}</div>${backgroundControls('derivatives',jobs.length,matching.length)}<p class="form-note">Derivative work is attempted once automatically. One authorized manual retry is available when recovery is supported.</p>`)}
function background(){return`<form id="background-search-form" class="project-toolbar background-toolbar" role="search"><label class="project-search"><span class="sr-only">Search background work</span><input name="query" type="search" value="${esc(state.backgroundQuery)}" placeholder="Search project, task, phase, or status" autocomplete="off"></label><button class="secondary-button" type="submit">Search</button>${state.backgroundQuery?button('clear-background-search','background','Clear'):''}</form>${operationActivity()}${derivativeActivity()}`}
function updateActivityIndicator(){const operations=state.operations.filter(operation=>OPERATION_ACTIVE.has(operation.status)).length,derivatives=state.derivativeJobs.filter(job=>job.status==='pending'||job.status==='leased').length,processing=state.tasks.filter(task=>LIVE_ATTEMPT_STATUSES.has(task.latestAttempt?.status)&&!state.operations.some(operation=>OPERATION_ACTIVE.has(operation.status)&&operation.processingAttemptId===task.latestAttempt?.id)).length,active=operations+derivatives+processing,count=document.querySelector('#background-work-count'),control=document.querySelector('#background-work-button');if(count)count.textContent=String(active);if(control){control.classList.toggle('has-active',active>0);control.setAttribute('aria-label',`Open background work; ${active} active job${active===1?'':'s'}`)}}
function renderOperationActivity(){updateActivityIndicator();const current=content.querySelector('#import-activity');if(!current)return;current.outerHTML=operationActivity();bindOperationActivity(content.querySelector('#import-activity')||content)}
function rememberOperation(operation){if(!operation?.id)return;state.operations=[operation,...state.operations.filter(item=>item.id!==operation.id)];renderOperationActivity()}
async function retryOperation(id){const retryButton=content.querySelector(`[data-action="retry-operation"][data-id="${CSS.escape(id)}"]`),recovery=['lod_recovery','companion_repair'].includes(state.operations.find(operation=>operation.id===id)?.type);if(retryButton){retryButton.disabled=true;retryButton.textContent='Retrying…'}try{const result=await api(`/api/v1/operations/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}});rememberOperation(result.operation);toast(result.operation.status==='awaiting_derivatives'?'Required derivative queued for retry':recovery?'Recovery version queued; the existing model remains safe':'Import queued for retry');scheduleOperationRefresh(500)}catch(error){toast(error.message,true);if(retryButton){retryButton.disabled=false;retryButton.textContent=recovery?'Retry recovery':'Retry import'}}}
async function retryDerivative(id){try{const result=await api(`/api/v1/processing/derivatives/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}});state.derivativeJobs=[result.derivative,...state.derivativeJobs.filter(item=>item.id!==id)];render();toast('Tile generation queued for retry');scheduleOperationRefresh(500)}catch(error){toast(error.message,true)}}
async function generateTiles(outputId){try{const result=await api(`/api/v1/processing/outputs/${encodeURIComponent(outputId)}/derivatives/tiles`,{method:'POST',body:{}});state.derivativeJobs=[result.derivative,...state.derivativeJobs.filter(item=>item.id!==result.derivative.id)];render();toast('3D tile generation queued');scheduleOperationRefresh(500)}catch(error){toast(error.message,true)}}
async function createLodRecovery(outputId,endpoint){const expected=`/api/v1/processing/outputs/${encodeURIComponent(outputId)}/lod-recovery-attempts`;if(endpoint!==expected)return toast('The recovery endpoint did not match this model output',true);if(state.busy)return;const control=content.querySelector(`[data-action="create-lod-recovery"][data-id="${CSS.escape(outputId)}"]`);state.busy=true;shell.setAttribute('aria-busy','true');if(control){control.disabled=true;control.textContent='Creating recovery…'}try{const result=await api(endpoint,{method:'POST',body:{},headers:{'Idempotency-Key':crypto.randomUUID()}});rememberOperation(result.operation);if(control)control.textContent='Recovery queued';toast('Recovery version queued. The existing model version remains safe and unchanged.');scheduleOperationRefresh(500)}catch(error){toast(error.message,true);if(control){control.disabled=false;control.textContent='Create recovery version'}}finally{state.busy=false;shell.removeAttribute('aria-busy')}}
async function createCompanionRepair(outputId, endpoint) {
  const expected = `/api/v1/processing/outputs/${encodeURIComponent(outputId)}/companion-repair-attempts`;
  if (endpoint !== expected) return toast('The product repair endpoint did not match this output', true);
  if (state.busy) return;
  const control = content.querySelector(`[data-action="restore-products"][data-id="${CSS.escape(outputId)}"]`);
  state.busy = true;
  shell.setAttribute('aria-busy', 'true');
  if (control) { control.disabled = true; control.textContent = 'Restoring products…'; }
  try {
    const result = await api(endpoint, { method: 'POST', body: {}, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    rememberOperation(result.operation);
    if (control) control.textContent = 'Product restore queued';
    toast('Product restore queued in a new version. Existing versions and publications are unchanged.');
    scheduleOperationRefresh(500);
  } catch (error) {
    toast(error.message, true);
    if (control) { control.disabled = false; control.textContent = 'Restore missing products'; }
  } finally {
    state.busy = false;
    shell.removeAttribute('aria-busy');
  }
}
function isCompanionRepairOperation(operation) {
  return operation?.type === 'companion_repair'
    || (operation?.type === 'lod_recovery' && operation.companionRepair === true);
}
function companionRepairAction(output) {
  const repair = output.companionRepairAction;
  if (!can('viewer.processing.write') || repair?.kind !== 'new_version') return '';
  const operation = [...state.operations].filter(item => isCompanionRepairOperation(item)
    && item.sourceOutputId === output.id && item.status !== 'cancelled')
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))[0];
  if (operation?.status === 'failed') return operation.retryable === false
    ? button('derivative-status', operation.id, 'Product restore failed', false, 'disabled')
    : button('retry-operation', operation.id, 'Retry product restore');
  if (operation) return button('derivative-status', operation.id,
    operation.status === 'succeeded' ? 'Products restored' : 'Restoring products…', false, 'disabled');
  if (!repair.eligible) return '';
  return button('restore-products', output.id, 'Restore missing products', false,
    `data-endpoint="${esc(repair.endpoint)}" title="${esc('Restore ' + (repair.missingAssetKinds || []).join(', ') + ' in a new version; existing published versions remain unchanged.')}"`);
}
async function refreshOperations(){if(!state.token||state.operationRefreshBusy)return false;state.operationRefreshBusy=true;try{const previous=new Map(state.operations.map(operation=>[operation.id,operation.status])),previousDerivatives=new Map(state.derivativeJobs.map(job=>[job.id,job.status])),[result,derivatives]=await Promise.all([pagedApi('/api/v1/operations','operations'),pagedApi('/api/v1/processing/derivatives','derivatives')]);state.operations=result.operations;state.derivativeJobs=derivatives.derivatives||[];if(state.section==='background')render();else renderOperationActivity();const completed=state.operations.some(operation=>operation.status==='succeeded'&&previous.has(operation.id)&&previous.get(operation.id)!=='succeeded'),derivativeCompleted=state.derivativeJobs.some(job=>['complete','failed'].includes(job.status)&&previousDerivatives.has(job.id)&&!['complete','failed'].includes(previousDerivatives.get(job.id)));if(completed||derivativeCompleted){toast(completed?'Background import completed':state.derivativeJobs.some(job=>job.status==='failed'&&previousDerivatives.has(job.id)&&!['complete','failed'].includes(previousDerivatives.get(job.id)))?'Background derivative failed':'Background derivative completed');if(state.section==='dashboard'&&state.selectedProjectId){await refreshProjectWorkspace(true);scheduleOperationRefresh();}else await load();return true}}catch(error){if(error.status!==401)console.warn('Background work refresh failed',error.message)}finally{state.operationRefreshBusy=false}return false}
function scheduleOperationRefresh(delay=null){clearTimeout(state.operationTimer);if(!state.token)return;const active=state.operations.some(operation=>OPERATION_ACTIVE.has(operation.status))||state.derivativeJobs.some(job=>job.status==='pending'||job.status==='leased'),wait=delay??(active?2000:15000);state.operationTimer=setTimeout(async()=>{const reloaded=await refreshOperations();if(!reloaded)scheduleOperationRefresh()},wait)}

function dashboard(){const work=taskPhaseCounts(state.tasks),healthy=state.providers.filter(provider=>provider.enabled&&['healthy','ready'].includes(provider.runtimeHealth||provider.lastHealth)).length;return`<div class="metric-grid dashboard-metrics">${metric('Projects',state.projects.length,'Viewer projects')}${metric('Ready tasks',state.tasks.filter(task=>state.outputs.some(output=>output.taskId===task.id&&(output.status==='ready'||(output.status==='published'&&output.activePublished)))).length,'Available to view and share')}${metric('Submitting',work.submitting,'Viewer upload or node-admission work')}${metric('Processing now',work.processing,`${work.queued} queued · ${work.finalizing} finalizing in Viewer`)}${metric('Provider nodes',`${healthy}/${state.providers.length}`,'Enabled and healthy')}</div><section class="project-workspace top-gap"><div class="project-toolbar"><label class="project-search"><span class="sr-only">Filter projects by name</span><input id="project-filter" type="search" value="${esc(state.projectQuery)}" placeholder="Search projects…" autocomplete="off"></label>${can('viewer.projects.write')?`<button type="button" class="secondary-button tree-toolbar-new-folder" data-action="tree-new-folder" data-id="">${treeIcon('folder')}New folder</button>`:''}</div><div id="project-list" class="project-list" role="treegrid" aria-label="Projects, folders and tasks">${projectRows()}</div></section>`}
function countLabel(count,noun){return`${count} ${noun}${count===1?'':'s'}`}
function activityChip(count,label,tone){return count?`<span class="activity-chip ${tone}">${count} ${esc(label)}</span>`:''}
function taskNeedsAttention(task){const status=task.latestAttempt?.status||task.status;return status==='failed'}
function taskTimestamp(value){if(!value)return'Unavailable';const date=new Date(value);return Number.isNaN(date.getTime())?'Unavailable':date.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}
function projectActions(project){
  const tasks=state.tasks.filter(task=>task.projectId===project.id),hasActiveTask=tasks.some(task=>LIVE_ATTEMPT_STATUSES.has(task.latestAttempt?.status)||['queued','processing'].includes(task.status)),canShare=['viewer.shares.create','viewer.shares.read','viewer.shares.revoke','viewer.client_grants.manage'].some(can);
  if(project.status!=='active')return'';
  const items=`${can('viewer.projects.write')?menuItem('folder-create',project.id,'New folder'):''}${can('viewer.projects.write')?menuItem('edit-project',project.id,'Rename project',{shortcut:'F2'}):''}${can('viewer.datasets.import')?menuItem('project-import',project.id,'Import existing results'):''}${can('viewer.projects.read')?menuItem('project-property-lines',project.id,'Property lines source'):''}${can('viewer.projects.write')&&!hasActiveTask?`${MENU_SEPARATOR}${menuItem('trash-project',project.id,'Delete project',{danger:true})}`:''}`;
  return`${can('viewer.processing.write')?`<button class="primary-button" data-action="project-process" data-id="${esc(project.id)}" tabindex="-1">New task</button>`:''}${canShare?button('project-share',project.id,'Share project',false,'tabindex="-1"'):''}${items?treeMenu('More project actions',items):''}`;
}
// The project row is level 1 of the tree; its actions show while it is open.
function projectHead(project){
  const tasks=state.tasks.filter(task=>task.projectId===project.id),datasets=state.datasets.filter(dataset=>dataset.projectId===project.id&&['draft','finalized'].includes(dataset.status)),work=taskPhaseCounts(tasks),ready=tasks.filter(task=>state.outputs.some(output=>output.taskId===task.id&&(output.status==='ready'||(output.status==='published'&&output.activePublished)))).length,open=isProjectOpen(project.id),failed=tasks.filter(task=>taskNeedsAttention(task)).length,actions=open?projectActions(project):'';
  // Source collections show once the project is open: not model versions or storage copies.
  const sourceSets=open?`<span class="project-source-count" title="Active source collections, not model versions or storage copies. Includes unused drafts; excludes archived and recycled sources."> · ${countLabel(datasets.length,'source set')}</span>`:'';
  const drop=project.status==='active'?` data-task-drop-project="${esc(project.id)}" data-task-drop-folder=""`:'';
  return`<div class="project-head tree-row" role="row" aria-level="1" aria-expanded="${open}" data-tree-key="p:${esc(project.id)}" data-tree-project="${esc(project.id)}"${drop}><div class="project-open-cell" role="gridcell"><button type="button" class="project-open" data-action="open-project" data-id="${esc(project.id)}" data-tree-focus tabindex="-1" aria-expanded="${open}" aria-controls="project-detail-${esc(project.id)}"><span class="project-name"><strong>${esc(project.displayName)}</strong>${project.description?`<small>${esc(project.description)}</small>`:''}</span><span class="project-summary">${countLabel(tasks.length,'task')}${ready?` · ${ready} ready`:''}${sourceSets}</span><span class="project-activity">${activityChip(work.submitting,'submitting','submitting')}${activityChip(work.queued,'queued','queued')}${activityChip(work.processing,'processing','processing')}${activityChip(work.finalizing,'finalizing','finalizing')}${activityChip(failed,'needs attention','failed')}</span>${project.status==='active'?'':badge(project.status)}<span class="project-chevron" aria-hidden="true">›</span><span class="tree-drop-hint" aria-hidden="true">Drop for top level</span></button></div>${actions?`<div class="project-head-actions row-actions" role="gridcell" aria-label="Project actions">${actions}</div>`:''}</div>`;
}
function projectRows(){const query=state.projectQuery.trim().toLocaleLowerCase('en-US'),projects=state.projects.filter(project=>!query||project.displayName.toLocaleLowerCase('en-US').includes(query));if(!projects.length)return empty(query?'No projects match that name.':'No projects yet.');return projects.map(project=>{const open=isProjectOpen(project.id);return`<article class="project-row ${open?'selected':''}" role="none" data-project-name="${esc(project.displayName.toLocaleLowerCase('en-US'))}">${projectHead(project)}${open?projectTree(project):''}</article>`}).join('')}
function taskLodNotice(task){
  const outputs=state.outputs.filter(output=>output.taskId===task.id),output=outputs.find(output=>output.activePublished&&output.status==='published')||outputs.find(output=>output.status==='ready');
  if(!output)return'';
  const lod=output.lod||{},job=lodJobForOutput(output),operation=recoveryOperationForOutput(output.id),status=['pending','queued','leased','running'].includes(job?.status)?job.status:lod.status||job?.status;
  let label='';
  if(operation&&['queued','leased','awaiting_derivatives','failed'].includes(operation.status))label=operation.status==='failed'?'Recovery needs attention':'Preparing streaming tiles';
  else if(lod.status==='available')return'';
  else if(['pending','queued','leased','running'].includes(status))label='Preparing streaming tiles';
  else if(['failed','fallback'].includes(status))label='Streaming needs attention';
  else if(lod.disabledByPolicy)label='Streaming disabled';
  else if(lod.canGenerate||lod.recoveryAction?.eligible)label='Streaming available to prepare';
  return label?`<small class="task-lod-notice" title="Open Task settings for streaming status and recovery actions.">${esc(label)}</small>`:'';
}
// The expanded task belongs to the selected project. When a refresh shows it gone (deleted or
// moved to another project elsewhere), the selection clears once no editor is active; a folder
// move made elsewhere expands its new folder so the open task stays visible.
function syncSelectedTaskFolder(projectId){
  const selected=state.tasks.find(task=>task.id===state.expandedTaskId&&task.projectId===projectId);
  if(state.expandedTaskId&&!selected&&state.selectedProjectId===projectId){
    const oldRow=content.querySelector(`[data-project-task="${CSS.escape(state.expandedTaskId)}"]`);
    if(taskEditActive(state.taskPage?content:oldRow))return true;
    const wasTaskPage=state.taskPage;
    state.expandedTaskId=null;state.taskPage=null;
    syncWorkspaceView('replace');
    if(wasTaskPage)render();
  }
  const detail=selected&&state.taskDetails[selected.id];
  if(detail?.task){
    if((detail.task.folderId||null)!==(selected.folderId||null)&&selected.folderId){treeReveals.set(projectId,selected.folderId);revealTreeFolder(projectId);}
    detail.task={...detail.task,...selected};
  }
  return false;
}

function taskEditActive(region){
  if(!region)return false;
  const work=currentWorkspaceNavigationState();
  return region.contains(document.activeElement)||work.unsavedGcpMark||work.pendingGcpSave;
}

function patchTaskOutput(panel,task,attempt,logs){
  const template=document.createElement('template');
  template.innerHTML=logPanel(task,attempt,logs);
  const fresh=template.content.firstElementChild;
  if(!fresh)return;

  for(const selector of ['.subsection-heading p','.task-output-status']){
    const current=panel.querySelector(selector),next=fresh.querySelector(selector);
    if(current.innerHTML!==next.innerHTML)current.replaceChildren(...next.childNodes);
  }
  const currentError=panel.querySelector('.form-note'),nextError=fresh.querySelector('.form-note');
  const tail=panel.querySelector('.log-tail'),nextTail=fresh.querySelector('.log-tail');
  if(nextError&&!currentError)tail.before(nextError);
  if(currentError&&!nextError)currentError.remove();
  if(tail.textContent===nextTail.textContent)return;
  const scrollTop=tail.scrollTop,atEnd=tail.scrollHeight-tail.clientHeight-scrollTop<24;
  tail.textContent=nextTail.textContent;
  tail.scrollTop=atEnd?tail.scrollHeight:scrollTop;
}

function patchSelectedTaskDetail(){
  const task=state.tasks.find(item=>item.id===state.expandedTaskId&&item.projectId===state.selectedProjectId);
  if(!task||state.taskPage==='gcp')return false;
  const row=content.querySelector(`[data-project-task="${CSS.escape(task.id)}"]`);
  const region=state.taskPage?content.querySelector('.task-workspace-page'):row?.querySelector('.task-detail-motion');
  if(!region)return false;
  const dataset=state.datasets.find(item=>item.id===task.datasetId),template=document.createElement('template');
  template.innerHTML=state.taskPage?taskWorkspaceBody(task,dataset):taskDetail(task,dataset);
  if(region.innerHTML===template.innerHTML)return false;
  if(taskEditActive(region))return true;
  const previousTail=region.querySelector('.log-tail'),tailTop=previousTail?.scrollTop||0;
  const atEnd=previousTail&&previousTail.scrollHeight-previousTail.clientHeight-tailTop<24;
  const scrollTop=content.scrollTop,pageTop=window.scrollY;
  region.replaceChildren(template.content);
  bindProjectActions(region);
  bindTaskDisclosures(region);
  hydrateOrthophotoPreviews(region);
  const tail=region.querySelector('.log-tail');
  if(tail)tail.scrollTop=atEnd?tail.scrollHeight:tailTop;
  if(content.scrollTop!==scrollTop)content.scrollTop=scrollTop;
  if(window.scrollY!==pageTop)window.scrollTo(window.scrollX,pageTop);
  return false;
}

// Updates one row in place from fresh markup; false when a held control (focus, an open menu
// or an inline name) means it must wait for a later paint. A focused row target is re-focused.
function syncTreeRow(row,fresh,focused){
  for(const name of row.getAttributeNames())if(name!=='class'&&!fresh.hasAttribute(name))row.removeAttribute(name);
  for(const name of fresh.getAttributeNames())if(name!=='class'&&row.getAttribute(name)!==fresh.getAttribute(name))row.setAttribute(name,fresh.getAttribute(name));
  if(row.className!==fresh.className){const kept=['tree-just-moved','tree-drag-source','folder-drop-active'].filter(name=>row.classList.contains(name));row.className=fresh.className;row.classList.add(...kept);}
  const target=row.querySelector('[data-tree-focus]'),freshTarget=fresh.querySelector('[data-tree-focus]');
  if(target&&freshTarget)freshTarget.tabIndex=target.tabIndex;
  if(row.matches('.task-panel')){
    const summary=row.querySelector(':scope > .task-summary'),newSummary=fresh.querySelector(':scope > .task-summary');
    if(!summary||!newSummary||summary.outerHTML===newSummary.outerHTML)return true;
    if(summary.contains(focused)||summary.querySelector('details[open]'))return false;
    summary.replaceWith(newSummary);return true;
  }
  if(row.innerHTML===fresh.innerHTML)return true;
  if(row.querySelector('details[open],.tree-inline-name'))return false;
  const refocus=Boolean(target)&&target===focused;
  if(row.contains(focused)&&!refocus)return false;
  row.replaceChildren(...fresh.childNodes);
  if(refocus)row.querySelector('[data-tree-focus]')?.focus({preventScroll:true});
  return true;
}
function syncProjectHead(project){
  const head=content.querySelector(`.project-head[data-tree-key="p:${CSS.escape(project.id)}"]`);
  if(!head)return true;
  const template=document.createElement('template');template.innerHTML=projectHead(project);
  return syncTreeRow(head,template.content.firstElementChild,document.activeElement);
}

// Patches one open project's tree in place. movedTaskId: a task this tab just moved or deleted;
// its row leaves its old place at once even while it holds focus (a mouse drag focuses the row).
// Other rows that hold focus, an open menu or an inline name, the row being dragged and the
// expanded task wait; the return value says a later paint is still needed.
function patchProjectTree(projectId,{movedTaskId=null,releasedKey=null}={}){
  if(state.taskPage)return patchSelectedTaskDetail();
  const section=content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"]`);
  const project=state.projects.find(item=>item.id===projectId);
  if(!section||!project)return false;
  const template=document.createElement('template');
  template.innerHTML=projectTree(project);
  const next=template.content.querySelector('[data-tree-body]');
  if(!next)return false;
  const focused=document.activeElement,scrollTop=content.scrollTop,pageTop=window.scrollY;
  const dragKey=draggedFolderTask?`t:${draggedFolderTask.id}`:null,movedKey=releasedKey||(movedTaskId?`t:${movedTaskId}`:null),expandedKey=state.expandedTaskId?`t:${state.expandedTaskId}`:null;
  const held=row=>row.contains(focused)||Boolean(row.querySelector('details[open],.tree-inline-name'));
  let pending=false;
  const oldRows=new Map();
  for(const row of [...section.children]){if(row.dataset.treeKey)oldRows.set(row.dataset.treeKey,row);else row.remove();}
  const wanted=[...next.children].filter(row=>row.dataset.treeKey);
  const wantedKeys=new Set(wanted.map(row=>row.dataset.treeKey));
  for(const [key,row] of oldRows){
    if(wantedKeys.has(key))continue;
    if(key!==movedKey&&(key===dragKey||key===expandedKey||held(row))){pending=true;continue;}
    row.remove();oldRows.delete(key);
  }
  let following=null;
  for(const fresh of wanted.reverse()){
    const key=fresh.dataset.treeKey,row=oldRows.get(key);
    if(!row){section.insertBefore(fresh,following);following=fresh;continue;}
    if(key!==dragKey&&!syncTreeRow(row,fresh,focused))pending=true;
    if(row.nextElementSibling!==following){
      if(key===movedKey||(key!==dragKey&&!row.contains(focused)&&!row.classList.contains('expanded')))section.insertBefore(row,following);
      else pending=true;
    }
    following=row;
  }
  if(!syncProjectHead(project))pending=true;
  bindProjectActions(section.closest('.project-row')||section);
  hydrateOrthophotoPreviews(section);
  if(content.scrollTop!==scrollTop)content.scrollTop=scrollTop;
  if(window.scrollY!==pageTop)window.scrollTo(window.scrollX,pageTop);
  syncTreeTabStop();
  return patchSelectedTaskDetail()||pending;
}
function repaintOpenProjects(){
  let pending=false;
  for(const projectId of openProjectIds())pending=patchProjectTree(projectId)||pending;
  return pending;
}
// Repaints a project after its folders load: in place when its tree is on the page (a drag in
// progress keeps its row), otherwise with the next render.
function paintProjectTree(projectId){
  if(state.section!=='dashboard'||state.taskPage||!isProjectOpen(projectId))return;
  if(content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"]`)){projectPaintPending=patchProjectTree(projectId)||projectPaintPending;return;}
  if(!draggedFolderTask)render();
}

function scheduleProjectRefresh(delay){
  if(delay===undefined&&projectRefreshTimer!==null)return;
  clearTimeout(projectRefreshTimer);
  projectRefreshTimer=null;
  if(document.hidden||!openProjectIds().length||state.section!=='dashboard'||!can('viewer.processing.read'))return;
  projectRefreshTimer=setTimeout(()=>{
    projectRefreshTimer=null;
    void refreshProjectWorkspace().finally(()=>scheduleProjectRefresh());
  },delay??8000);
}

// Link lists for the outputs that are published now, not when the read began. Every local change (a new link, an
// edit, a Share dialog's own read) stores a new array, so a list that changed meanwhile is newer than this read.
function currentShares(published,results,before){
  const read=new Map(published.map((output,index)=>[output.id,results[index].value?.shares||[]])),next={};
  for(const output of state.outputs)if(output.activePublished)next[output.id]=read.get(output.id)||state.shares[output.id]||[];
  for(const [id,shares] of Object.entries(state.shares))if(shares!==before[id])next[id]=shares;
  return next;
}
// Reads one project's outputs again from any section, whether or not the project is open or a full load is running.
async function refreshProjectOutputs(projectId){
  const token=state.token,session=state.adminSession,fence=outputFences.get(projectId);
  const current=()=>Boolean(token)&&token===state.token&&session===state.adminSession&&fence===outputFences.get(projectId);
  let read=false;
  try{
    const result=await pagedApi(`/api/v1/processing/outputs?projectId=${encodeURIComponent(projectId)}`,'outputs',{recoveryGuard:current});
    if(!current())return;
    state.outputs=[...state.outputs.filter(item=>item.projectId!==projectId),...result.outputs];
    read=true;
    const detail=state.taskDetails[state.expandedTaskId]?.task;
    if(detail&&detail.projectId===projectId)detail.outputs=result.outputs.filter(item=>item.taskId===detail.id);
    if(state.section==='dashboard')projectPaintPending=patchProjectTree(projectId)||projectPaintPending;
  }catch(error){
    if(!current())return;
    // The open project's next poll, or opening the project, reads them again.
    projectArtifactsRefreshId=new Set([...(projectArtifactsRefreshId||[]),projectId]);
    if(error.status!==401)console.warn('Project output refresh failed',error.message);
  }
  return read;
}

// Refreshes every open project's tasks and folders, one project at a time.
async function refreshProjectWorkspace(includeArtifacts=false){
  const projectIds=openProjectIds();
  if(includeArtifacts)projectArtifactsRefreshId=new Set(projectIds);
  if(!projectIds.length||projectRefreshBusy||workspaceLoads||state.busy||document.hidden||!can('viewer.processing.read'))return;
  projectRefreshBusy=true;
  try{
    let pending=false;
    for(const projectId of projectIds){
      if(!isProjectOpen(projectId))continue;
      pending=(await refreshProjectData(projectId))||pending;
    }
    if(projectPaintPending)pending=repaintOpenProjects()||pending;
    projectPaintPending=pending;
  }finally{
    projectRefreshBusy=false;
  }
}
async function refreshProjectData(projectId){
  const entry=folderCache.get(projectId);
  if(!entry||entry.loading)return false;
  const artifacts=Boolean(projectArtifactsRefreshId?.has(projectId));
  const authorized=folderAuthorizationGuard(projectId);
  const generation=projectDataGeneration,fence=outputFences.get(projectId);
  const current=()=>authorized()&&generation===projectDataGeneration&&!state.busy&&!workspaceLoads&&!document.hidden&&folderCache.get(projectId)===entry;
  if(!current())return false;
  try{
    const project=encodeURIComponent(projectId),options={recoveryGuard:current},readDatasets=artifacts&&can('viewer.datasets.read');
    const [taskResult,folderResult,datasetResult,outputResult]=await Promise.all([
      pagedApi(`/api/v1/tasks?projectId=${project}`,'tasks',options),
      api(`/api/v1/projects/${project}/folders`,options),
      readDatasets?pagedApi(`/api/v1/datasets?projectId=${project}`,'datasets',options):null,
      artifacts?pagedApi(`/api/v1/processing/outputs?projectId=${project}`,'outputs',options):null
    ]);
    if(!current()||!Array.isArray(folderResult.folders))return false;
    const tasks=taskResult.tasks.filter(task=>task.projectId===projectId);
    const folders=folderResult.folders.filter(folder=>folder.projectId===projectId);
    const previousTasks=state.tasks.filter(task=>task.projectId===projectId);
    const changed=JSON.stringify(previousTasks)!==JSON.stringify(tasks)||JSON.stringify(entry.folders)!==JSON.stringify(folders)||artifacts;
    if(!changed)return false;
    projectDataGeneration++;
    state.tasks=[...state.tasks.filter(task=>task.projectId!==projectId),...tasks];
    if(datasetResult)state.datasets=[...state.datasets.filter(item=>item.projectId!==projectId),...datasetResult.datasets];
    const outputsCurrent=fence===outputFences.get(projectId);
    if(outputResult&&outputsCurrent){
      state.outputs=[...state.outputs.filter(item=>item.projectId!==projectId),...outputResult.outputs];
      const detail=state.taskDetails[state.expandedTaskId]?.task;
      if(detail&&detail.projectId===projectId)detail.outputs=outputResult.outputs.filter(item=>item.taskId===detail.id);
    }
    entry.folders=folders;entry.error=null;
    if(artifacts&&outputsCurrent)projectArtifactsRefreshId.delete(projectId);
    const selectionPending=syncSelectedTaskFolder(projectId);
    return patchProjectTree(projectId)||selectionPending;
  }catch(error){
    if(current()&&error.status!==401)console.warn('Project refresh failed',error.message);
    return false;
  }
}

const TREE_ICONS={
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen:'<path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.5"/><path d="M3 17.5 5.3 11.6A1 1 0 0 1 6.2 11H21a.6.6 0 0 1 .56.8l-2.2 6a1.8 1.8 0 0 1-1.7 1.2H4.4A1.4 1.4 0 0 1 3 17.5z"/>',
  task:'<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
};
function treeIcon(name){return`<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TREE_ICONS[name]}</svg>`}
const TREE_GRIP='<svg class="tree-drag-grip" viewBox="0 0 10 18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="4" r="1.3"/><circle cx="7" cy="4" r="1.3"/><circle cx="3" cy="9" r="1.3"/><circle cx="7" cy="9" r="1.3"/><circle cx="3" cy="14" r="1.3"/><circle cx="7" cy="14" r="1.3"/></svg>';
// Phones and touch screens move tasks with Move to…; drag is for a desktop pointer.
function treeDragAvailable(){return typeof matchMedia!=='function'||!matchMedia('(max-width:767px),(pointer:coarse)').matches}
function menuItem(action,id,label,{danger=false,disabled='',shortcut='',extra=''}={}){return`<button type="button" class="secondary-button${danger?' danger-button':''}" role="menuitem" tabindex="-1" data-action="${esc(action)}" data-id="${esc(id)}" ${disabled?`aria-disabled="true" title="${esc(disabled)}"`:''} ${extra}>${esc(label)}${shortcut?`<span class="menu-shortcut" aria-hidden="true">${esc(shortcut)}</span>`:''}</button>`}
const MENU_SEPARATOR='<div class="menu-separator" role="separator"></div>';
function treeMenu(label,items,className=''){return`<details class="project-more-actions tree-menu ${className}"><summary tabindex="-1" aria-label="${esc(label)}" title="${esc(label)}" aria-haspopup="menu">⋯</summary><div class="project-more-menu" role="menu" aria-label="${esc(label)}">${items}</div></details>`}
function canWriteFolders(project){return project?.status==='active'&&can('viewer.projects.write')}
function uniqueFolderName(folders,parentId){
  const taken=new Set(folders.filter(folder=>(folder.parentId||null)===parentId).map(folder=>folder.displayName.toLocaleLowerCase('en-US')));
  let name='New folder';for(let index=2;taken.has(name.toLocaleLowerCase('en-US'));index++)name=`New folder ${index}`;
  return name;
}
function treeRowAttributes(row,projectId){return`role="row" aria-level="${row.level}"${row.posinset?` aria-posinset="${row.posinset}" aria-setsize="${row.setsize}"`:''} data-tree-key="${esc(row.key)}" data-tree-parent="${esc(row.parentKey)}" data-tree-project="${esc(projectId)}" style="--tree-depth:${row.level-2}"`}
function folderTreeRow(row,project,folders,tasks,counts){
  const folder=row.folder,writable=canWriteFolders(project),renaming=treeRenaming===row.key,emptyFolder=folderIsEmpty(folders,tasks,folder.id);
  const tasksInside=counts.get(folder.id)||0,count=emptyFolder?'Empty':tasksInside?countLabel(tasksInside,'task'):'No tasks';
  const drop=project.status==='active'?` data-task-drop-project="${esc(project.id)}" data-task-drop-folder="${esc(folder.id)}"`:'';
  const name=renaming
    ?`<span class="tree-toggle folder-toggle is-editing"><span class="tree-chevron" aria-hidden="true">›</span>${treeIcon(row.expanded?'folderOpen':'folder')}<input class="tree-inline-name" data-tree-rename="${esc(folder.id)}" data-project-id="${esc(project.id)}" value="${esc(folder.displayName)}" aria-label="Folder name" maxlength="160" autocomplete="off"></span>`
    :`<button type="button" class="tree-toggle folder-toggle" data-action="folder-toggle" data-id="${esc(folder.id)}" data-project-id="${esc(project.id)}" data-tree-focus tabindex="-1" aria-expanded="${row.expanded}"><span class="tree-chevron" aria-hidden="true">›</span>${treeIcon(row.expanded?'folderOpen':'folder')}<span class="tree-name"><strong>${esc(folder.displayName)}</strong><span class="tree-count">${esc(count)}</span></span></button>`;
  const menu=writable&&!renaming?treeMenu(`More actions for ${folder.displayName}`,`${menuItem('folder-new',folder.id,'New subfolder',{extra:`data-project-id="${esc(project.id)}"`})}${menuItem('folder-rename',folder.id,'Rename',{shortcut:'F2',extra:`data-project-id="${esc(project.id)}"`})}${MENU_SEPARATOR}${menuItem('folder-delete',folder.id,'Delete',{danger:true,disabled:emptyFolder?'':'Only empty folders can be deleted.',extra:`data-project-id="${esc(project.id)}"`})}`):'';
  return`<div class="tree-row folder-tree-row" ${treeRowAttributes(row,project.id)} aria-expanded="${row.expanded}"${drop}><div class="tree-cell tree-name-cell" role="gridcell">${name}</div><div class="tree-cell row-actions" role="gridcell">${menu}</div></div>`;
}
function newFolderTreeRow(row,project){
  return`<div class="tree-row folder-tree-row tree-new-row" ${treeRowAttributes(row,project.id)}><div class="tree-cell tree-name-cell" role="gridcell"><span class="tree-toggle folder-toggle is-editing"><span class="tree-chevron" aria-hidden="true">›</span>${treeIcon('folder')}<input class="tree-inline-name" data-tree-new-folder="${esc(row.parentId||'')}" data-project-id="${esc(project.id)}" value="${esc(uniqueFolderName(folderCache.get(project.id)?.folders||[],row.parentId||null))}" aria-label="New folder name" maxlength="160" autocomplete="off"></span></div></div>`;
}
function emptyTreeRow(key,level,parentKey,project,folderId,text){
  const drop=project.status==='active'?` data-task-drop-project="${esc(project.id)}" data-task-drop-folder="${esc(folderId||'')}"`:'';
  return`<div class="tree-row tree-empty-row" role="row" aria-level="${level}" data-tree-key="${esc(key)}" data-tree-parent="${esc(parentKey)}" style="--tree-depth:${level-2}"${drop}><div class="tree-cell" role="gridcell">${esc(text)}</div></div>`;
}
function statusTreeRow(key,body){return`<div class="tree-row tree-status-row" role="row" aria-level="2" data-tree-key="${esc(key)}" style="--tree-depth:0"><div class="tree-cell" role="gridcell">${body}</div></div>`}

// One open project's rows: folders and tasks inline, children right under their open folder.
function projectTree(project){
  if(!folderCache.has(project.id)&&isProjectOpen(project.id)){folderCache.set(project.id,{folders:null,error:null,loading:true});queueMicrotask(()=>{if(isProjectOpen(project.id))loadProjectFolders(project.id)});}
  const entry=folderCache.get(project.id),allTasks=state.tasks.filter(task=>task.projectId===project.id);
  const folders=entry?.folders||[],loadingFirst=Boolean(entry?.loading&&!entry.folders);
  // Until the first folder read lands only top-level tasks show; an error shows every task at the top.
  const tasks=loadingFirst?allTasks.filter(task=>!task.folderId):allTasks;
  const pending=treePending?.projectId===project.id&&canWriteFolders(project)?treePending:null;
  const rows=projectTreeRows({projectId:project.id,folders,tasks,expanded:treeState.folders,pending});
  const counts=folderTaskCounts(folders,allTasks);
  let html='';
  if(loadingFirst)html+=statusTreeRow('s:loading','<p role="status">Loading folders…</p>');
  if(entry?.error)html+=statusTreeRow('s:error',`<p role="alert">${esc(entry.error)} Showing every task at the top level.</p>${button('folder-retry',project.id,'Retry folders')}`);
  if(project.status!=='active')html+=statusTreeRow('s:archived','<p class="form-note">This project is archived and read-only.</p>');
  for(const row of rows){
    if(row.kind==='folder')html+=folderTreeRow(row,project,folders,allTasks,counts);
    else if(row.kind==='task')html+=taskPanel(row.task,row);
    else if(row.kind==='new')html+=newFolderTreeRow(row,project);
    else if(row.kind==='empty')html+=emptyTreeRow(row.key,row.level,row.parentKey,project,row.folderId,treeDragAvailable()?'Empty. Drop tasks here.':'Empty folder');
  }
  if(!rows.length&&!loadingFirst)html+=emptyTreeRow(`e:${project.id}`,2,`p:${project.id}`,project,null,'No folders or tasks here yet.');
  return`<section class="project-detail tree-body" id="project-detail-${esc(project.id)}" role="rowgroup" aria-label="${esc(project.displayName)} tasks and actions" data-tree-body="${esc(project.id)}">${html}</section>`;
}

function datasetActions(dataset,projectActive){if(!projectActive)return'';const items=[];if(dataset.status==='draft'&&can('viewer.datasets.write'))items.push(button('upload-dataset',dataset.id,'Upload'));if(['draft','finalized','archived'].includes(dataset.status)&&can('viewer.storage.purge'))items.push(dangerButton('trash-dataset',dataset.id,'Move source to Recycle Bin'));return items.join('')}
function lodJobForOutput(output){return state.derivativeJobs.find(job=>job.attemptId===output.attemptId&&['mesh_tiles','lod_audit'].includes(job.type))||null}
function recoveryOperationForOutput(outputId){return[...state.operations].filter(operation=>operation.type==='lod_recovery'&&operation.status!=='cancelled'&&(operation.sourceOutputId===outputId||operation.result?.recovery?.sourceOutputId===outputId)).sort((left,right)=>Date.parse(right.updatedAt||right.createdAt||0)-Date.parse(left.updatedAt||left.createdAt||0))[0]||null}
function lodAction(output){if(!can('viewer.processing.write'))return'';const repair=companionRepairAction(output);if(repair)return repair;const job=lodJobForOutput(output),lod=output.lod||{},recovery=lod.recoveryAction,feedStatus=job?.status==='pending'?'queued':job?.status==='leased'?'running':job?.status,status=feedStatus||lod.status,id=job?.id||lod.jobId||output.id,retryable=Boolean(lod.canRetry||(status==='failed'&&job?.optional&&(Number(job.manualRetryCount)||0)<1));if(recovery?.kind==='new_version'&&recovery.eligible){const existing=recoveryOperationForOutput(output.id);if(existing?.status==='failed')return existing.retryable===false?button('derivative-status',existing.id,'Recovery retry exhausted',false,'disabled title="The one authorized manual recovery retry has already failed."'):button('retry-operation',existing.id,'Retry recovery',false,'title="Retry the existing recovery version without changing the current model."');if(existing){const label=existing.status==='queued'?'Recovery queued':existing.status==='leased'?'Creating recovery…':existing.status==='awaiting_derivatives'?'Generating 3D tiles…':'Recovery complete';return button('derivative-status',existing.id,label,false,'disabled')}return button('create-lod-recovery',output.id,'Create recovery version',false,`data-endpoint="${esc(recovery.endpoint)}" title="The current version remains safe while a new recovery version is built."`)}if(lod.disabledByPolicy)return button('derivative-status',id,'3D tiles disabled by server',false,`disabled title="${esc(lod.reason||'3D tile generation is disabled on this Viewer deployment.')}"`);if(['failed','fallback'].includes(status)&&retryable)return button('retry-derivative',id,'Retry 3D tiles');if(status==='queued')return button('derivative-status',id,'3D tiles queued',false,'disabled');if(status==='running')return button('derivative-status',id,'Generating 3D tiles…',false,'disabled');if(status==='available'||(status==='complete'&&job?.result?.verified))return button('derivative-status',id,'3D tiles ready',false,'disabled');if(status==='fallback')return button('derivative-status',id,'Using full mesh fallback',false,`disabled title="${esc(lod.reason||'Verified streaming tiles are unavailable.')}"`);if(lod.canGenerate)return button('generate-tiles',output.id,'Generate 3D tiles');return''}
function taskQuickActions(task){const outputs=state.outputs.filter(item=>item.taskId===task.id),output=outputs.find(item=>item.activePublished&&item.status==='published')||outputs.find(item=>item.status==='ready'&&item.attemptId),readOnly=task.status==='archived'||state.projects.find(project=>project.id===task.projectId)?.status!=='active',items=[],more=[];let download='';if(output){const kinds=new Set(Array.isArray(output.assetKinds)?output.assetKinds:[]),published=output.activePublished&&output.status==='published';if(published&&output.viewSessionUrl)items.push(button('view-output',output.id,'View',true,'tabindex="-1"'));else if(!readOnly&&output.status==='ready'&&output.attemptId&&can('viewer.processing.publish'))items.push(button('open-review',output.attemptId,'View',true,'tabindex="-1"'));if(output.reportUrl&&kinds.has('report'))items.push(button('download-report',output.id,'Model report',false,`tabindex="-1" data-url="${esc(output.reportUrl)}"`));if(!readOnly&&canShareOutput(output))items.push(button('share-output',output.id,'Share',false,'tabindex="-1"'));if(output.downloadProducts?.length||output.downloadUrl&&kinds.size)download=menuItem('download-output',output.id,'Download model files',{extra:`data-url="${esc(output.downloadUrl)}"`})}const writable=!readOnly&&can('viewer.processing.write');if(writable){more.push(menuItem('edit-task',task.id,'Rename',{shortcut:'F2'}),menuItem('folder-move-task',task.id,'Move to…',{disabled:Array.isArray(folderCache.get(task.projectId)?.folders)?'':'Folders are still loading.'}),menuItem('duplicate-task',task.id,'Duplicate',{disabled:state.datasets.some(item=>item.id===task.datasetId&&item.status==='finalized')?'':'Its source photos are not ready.'}));}if(download)more.push(download);more.push(menuItem('task-settings',task.id,'Details & processing'),menuItem('task-files',task.id,'Files & versions'),menuItem('task-history',task.id,'Processing history'));if(!readOnly&&can('viewer.gcp.read'))more.push(menuItem('task-gcp',task.id,'Ground control points'));if(writable)more.push(MENU_SEPARATOR,menuItem('delete-task',task.id,'Delete',{danger:true,disabled:LIVE_ATTEMPT_STATUSES.has(task.latestAttempt?.status)?'Stop processing before deleting this task.':''}));items.push(treeMenu('More task actions',more.join(''),'task-more-actions'));return items.join('')}
function taskPanel(task,row=null){const attempt=task.latestAttempt||{},expanded=state.expandedTaskId===task.id,dataset=state.datasets.find(item=>item.id===task.datasetId),sourceImages=task.metrics?.sourceImageCount,panelId=`task-detail-${task.id}`,quickActions=taskQuickActions(task),drag=Boolean(row)&&canDragFolderTask(task)&&treeDragAvailable();return`<article class="task-panel tree-row ${expanded?'expanded':''}" data-project-task="${esc(task.id)}"${row?` ${treeRowAttributes(row,task.projectId)}`:''}><div class="task-summary"${row?' role="gridcell"':''}${drag?` draggable="true" data-folder-drag data-id="${esc(task.id)}"`:''}>${drag?TREE_GRIP:''}<button class="task-summary-toggle" data-action="toggle-task" data-id="${esc(task.id)}" data-tree-focus tabindex="-1" aria-expanded="${expanded}" aria-controls="${esc(panelId)}"><span class="task-lead" aria-hidden="true"><span class="task-chevron">›</span>${treeIcon('task')}</span><span class="task-summary-name"><strong>${esc(task.displayName)}</strong><small>${taskTimestamp(task.createdAt)}</small>${taskLodNotice(task)}</span><span class="task-summary-stat" title="${task.metrics?.sourceImageCountSource==='registered_camera_originals'?'Original photos registered with this model version; processing input count was not recorded.':'Registered source images; unavailable counts are not estimated.'}"><strong>${sourceImages==null?'Not recorded':groupedNumber(sourceImages)}</strong><small>images</small></span><span class="task-summary-stat"><strong>${duration(attempt,task.metrics)}</strong><small>runtime</small></span>${badge(['ready_for_review','published'].includes(attempt.status||task.status)?'ready':attempt.status||task.status)}</button><div class="task-quick-actions row-actions" aria-label="${esc(task.displayName)} actions">${quickActions}</div></div><div class="task-detail-shell" id="${esc(panelId)}" role="${row?'gridcell':'region'}" aria-label="${esc(task.displayName)} details" ${expanded?'':'inert'}><div class="task-detail-motion">${expanded?taskDetail(task,dataset):''}</div></div></article>`}
function taskFact(label,value){const display=label==='Reconstructed points'&&value!==null&&value!==undefined?groupedNumber(value):value;return`<div><dt>${esc(label)}</dt><dd>${available(display)}</dd></div>`}
function disclosureAttributes(taskId,name){return`data-task-id="${esc(taskId)}" data-task-disclosure="${esc(name)}" ${state.taskDisclosures[taskId]?.[name]?'open':''}`}
function taskDisclosurePanel(taskId,name,label,body,meta=''){return`<details class="task-subsection task-disclosure" ${disclosureAttributes(taskId,name)}><summary><span>${esc(label)}</span>${meta?`<small>${esc(meta)}</small>`:''}</summary><div class="task-disclosure-body">${body}</div></details>`}
function publishedOrthophoto(outputs){return outputs.find(output=>output.activePublished&&output.status==='published'&&Array.isArray(output.assetKinds)&&output.assetKinds.includes('ortho'))||null}
function orthophotoPreview(task,outputs){const output=publishedOrthophoto(outputs);if(!output)return'';const cached=state.orthophotoPreviews[output.id];if(cached?.status==='ready')return`<figure class="task-ortho-preview"><img src="${esc(cached.dataUrl)}" alt="Orthophoto preview for ${esc(task.displayName)}"><figcaption>Published orthophoto</figcaption></figure>`;if(cached?.status==='failed')return`<figure class="task-ortho-preview unavailable"><div role="img" aria-label="Orthophoto preview unavailable">Preview unavailable</div><figcaption>Published orthophoto</figcaption></figure>`;return`<figure class="task-ortho-preview loading"><canvas width="420" height="236" data-ortho-output-id="${esc(output.id)}" role="img" aria-label="Loading the published orthophoto preview for ${esc(task.displayName)}"></canvas><figcaption>Published orthophoto</figcaption></figure>`}
async function renderOrthophotoPreview(canvas,outputId){if(state.orthophotoPreviews[outputId]?.status==='loading')return;state.orthophotoPreviews[outputId]={status:'loading'};try{if(!orthophotoPool)orthophotoPool=new GeoTiffPool(Math.min(2,navigator.hardwareConcurrency||2));const tiff=await openGeoTiff(`/api/v1/processing/outputs/${encodeURIComponent(outputId)}/assets/ortho`,{headers:{Authorization:`Bearer ${state.token}`},allowFullFile:false,blockSize:262144,cacheSize:12}),count=await tiff.getImageCount();let image=await tiff.getImage(count-1);for(let index=0;index<count;index++){const candidate=await tiff.getImage(index);image=candidate;if(Math.max(candidate.getWidth(),candidate.getHeight())<=640)break}const sourceWidth=image.getWidth(),sourceHeight=image.getHeight(),scale=Math.min(1,480/Math.max(sourceWidth,sourceHeight)),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale)),rgb=await image.readRGB({width,height,interleave:true,enableAlpha:true,pool:orthophotoPool,resampleMethod:'bilinear'}),bits=Math.max(...Array.from(image.fileDirectory.getValue('BitsPerSample')||[8])),channelScale=bits>8?255/(2**bits-1):1,channels=rgb.length/(width*height),nodata=parseFiniteGdalNoData(image.getGDALNoData()),context=canvas.getContext('2d'),pixels=context.createImageData(width,height);canvas.width=width;canvas.height=height;for(let source=0,target=0;target<pixels.data.length;source+=channels,target+=4){pixels.data[target]=rgb[source]*channelScale;pixels.data[target+1]=rgb[source+1]*channelScale;pixels.data[target+2]=rgb[source+2]*channelScale;pixels.data[target+3]=isRgbNoData(rgb[source],rgb[source+1],rgb[source+2],nodata)?0:channels>=4?rgb[source+3]*channelScale:255}context.putImageData(pixels,0,0);state.orthophotoPreviews[outputId]={status:'ready',dataUrl:canvas.toDataURL('image/png')};canvas.setAttribute('aria-label','Published orthophoto preview')}catch(error){console.warn('orthophoto preview unavailable',{outputId,message:error instanceof Error?error.message:String(error)});state.orthophotoPreviews[outputId]={status:'failed'};const figure=canvas.closest('.task-ortho-preview');if(figure){figure.className='task-ortho-preview unavailable';figure.innerHTML='<div role="img" aria-label="Orthophoto preview unavailable">Preview unavailable</div><figcaption>Published orthophoto</figcaption>'}}}
function hydrateOrthophotoPreviews(root=content){root.querySelectorAll('[data-ortho-output-id]').forEach(canvas=>{const outputId=canvas.dataset.orthoOutputId;void renderOrthophotoPreview(canvas,outputId).then(()=>synchronizeOrthophotoPreviews(content,outputId,state.orthophotoPreviews[outputId]))})}
function bindTaskDisclosures(root=content){root.querySelectorAll('[data-task-disclosure]').forEach(disclosure=>disclosure.addEventListener('toggle',()=>{const taskId=disclosure.dataset.taskId,name=disclosure.dataset.taskDisclosure;state.taskDisclosures[taskId]={...(state.taskDisclosures[taskId]||{}),[name]:disclosure.open}}))}
function reducedMotion(){return window.matchMedia('(prefers-reduced-motion: reduce)').matches}
function animateOpenedTask(taskId){if(reducedMotion())return;queueMicrotask(()=>{const motion=content.querySelector(`[data-action="toggle-task"][data-id="${CSS.escape(taskId)}"]`)?.closest('.task-panel')?.querySelector('.task-detail-motion');if(!motion)return;const animation=motion.animate([{height:'0px',opacity:0,transform:'translateY(-6px)'},{height:`${motion.scrollHeight}px`,opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});animation.onfinish=()=>{motion.style.height='';motion.style.opacity='';motion.style.transform=''}})}
async function collapseTask(taskId){const motion=content.querySelector(`[data-action="toggle-task"][data-id="${CSS.escape(taskId)}"]`)?.closest('.task-panel')?.querySelector('.task-detail-motion');if(motion&&!reducedMotion())await motion.animate([{height:`${motion.scrollHeight}px`,opacity:1},{height:'0px',opacity:0}],{duration:160,easing:'ease-in'}).finished.catch(()=>undefined);releaseGcpImage(gcpWorkspace(taskId));if(state.expandedTaskId===taskId)state.expandedTaskId=null;syncWorkspaceView('push');render()}
function taskDetail(task,dataset){const detail=state.taskDetails[task.id],attempt=detail?.task?.latestAttempt||task.latestAttempt||{},metrics=detail?.task?.metrics||task.metrics||{},storage=detail?.storage?.task,outputs=detail?.task?.outputs||state.outputs.filter(output=>output.taskId===task.id),units=state.adminSession?.displayUnits||'imperial',projectActive=state.projects.find(project=>project.id===task.projectId)?.status==='active',readOnly=task.status==='archived'||!projectActive;if(detail?.loading)return`<div class="task-detail">${empty('Loading authoritative task details…')}</div>`;const controls=readOnly?`<p class="form-note">This ${task.status==='archived'?'task':'project'} is archived and read-only.</p>`:`<div class="row-actions task-lifecycle">${can('viewer.processing.write')?`${button('edit-task',task.id,'Rename')}${activeTaskAction(task,attempt)}${!LIVE_ATTEMPT_STATUSES.has(attempt.status)?dangerButton('trash-task',task.id,'Delete'):''}`:''}</div>`,datasetControls=dataset&&!readOnly&&datasetActions(dataset,projectActive)?`<div class="linked-dataset-actions"><p class="form-note">Linked dataset lifecycle</p><div class="row-actions">${datasetActions(dataset,projectActive)}</div></div>`:'',status=metrics.processingStatus||attempt.status||task.status,outputCount=metrics.outputCount??outputs.length,diskUsage=metrics.taskDiskUsageBytes==null?(storage?.totalBytes===undefined?null:bytes(storage.totalBytes)):bytes(metrics.taskDiskUsageBytes),gcp=detail?.gcp||{sets:[]},gcpCount=(gcp.sets||[]).reduce((sum,set)=>sum+(Number(set.pointCount)||0),0),running=LIVE_ATTEMPT_STATUSES.has(attempt.status);return`<div class="task-detail compact-task-detail"><section class="task-overview"><div class="task-overview-grid"><div><dl class="task-facts">${taskFact('Average GSD',metrics.averageGsdM==null?null:formatGsd(metrics.averageGsdM,units))}${taskFact('Surveyed area',metrics.surveyedAreaM2==null?null:formatArea(metrics.surveyedAreaM2,units))}${taskFact('Reconstructed points',metrics.reconstructedPointCount)}${taskFact('Georeferencing CRS',metrics.georeferencingCrs)}${taskFact('Task disk usage',diskUsage)}</dl><p class="form-note task-authority-note">Some survey statistics are not available yet. These fields are separate from node connection health.</p>${readOnly?controls:activeTaskAction(task,attempt)}</div>${orthophotoPreview(task,outputs)}</div></section>${running?logPanel(task,detail?.attempt||attempt,detail?.logs||[]):''}</div>`}
function taskWorkspaceBody(task,dataset){const detail=state.taskDetails[task.id],attempt=detail?.task?.latestAttempt||task.latestAttempt||{},metrics=detail?.task?.metrics||task.metrics||{},storage=detail?.storage?.task,outputs=detail?.task?.outputs||state.outputs.filter(output=>output.taskId===task.id),units=state.adminSession?.displayUnits||'imperial',projectActive=state.projects.find(project=>project.id===task.projectId)?.status==='active',readOnly=task.status==='archived'||!projectActive;if(detail?.loading)return`<div class="task-detail">${empty('Loading authoritative task details…')}</div>`;const controls=readOnly?`<p class="form-note">This ${task.status==='archived'?'task':'project'} is archived and read-only.</p>`:`<div class="row-actions task-lifecycle">${can('viewer.processing.write')?`${button('edit-task',task.id,'Rename')}${activeTaskAction(task,attempt)}${!LIVE_ATTEMPT_STATUSES.has(attempt.status)?dangerButton('trash-task',task.id,'Move task to Recycle Bin'):''}`:''}</div>`,datasetControls=dataset&&!readOnly&&datasetActions(dataset,projectActive)?`<div class="linked-dataset-actions"><p class="form-note">Linked dataset lifecycle</p><div class="row-actions">${datasetActions(dataset,projectActive)}</div></div>`:'',status=metrics.processingStatus||attempt.status||task.status,outputCount=metrics.outputCount??outputs.length,diskUsage=metrics.taskDiskUsageBytes==null?(storage?.totalBytes===undefined?null:bytes(storage.totalBytes)):bytes(metrics.taskDiskUsageBytes),gcp=detail?.gcp||{sets:[]},gcpCount=(gcp.sets||[]).reduce((sum,set)=>sum+(Number(set.pointCount)||0),0),running=LIVE_ATTEMPT_STATUSES.has(attempt.status);if(state.taskPage==='gcp')return can('viewer.gcp.read')&&!readOnly?gcpPanel(task,dataset,gcp):empty('Ground-control editing is unavailable for this task or permission.');if(state.taskPage==='files')return outputPanel(task,attempt,outputs,!readOnly);return`<dl class="task-options">${taskFact('Task ID',task.id)}${taskFact('Created',dateTime(task.createdAt))}${taskFact('Dataset',dataset?.displayName||null)}${taskFact('Source images',metrics.sourceImageCount)}${taskFact('Processing duration',duration(attempt,metrics))}${taskFact('Provider',attemptProviderName(attempt,state.providers))}${taskFact('Preset',state.presets.find(preset=>preset.id===attempt.presetId)?.displayName||'Provider defaults')}${taskFact('Outputs',outputCount?`${outputCount} available`:'Unavailable')}${taskFact('Status',String(status||'unknown').replaceAll('_',' '))}</dl>${logPanel(task,detail?.attempt||attempt,detail?.logs||[])}${controls}${!readOnly?`<section class="task-streaming-settings"><h3>Streaming and product recovery</h3><div class="row-actions">${outputs.map(output=>lodAction(output)).join('')||'<p class="form-note">No streaming actions are needed.</p>'}</div></section>`:''}${datasetControls}`}
function taskWorkspacePage(){const task=state.tasks.find(item=>item.id===state.expandedTaskId);if(!task)return empty('Task unavailable.');const dataset=state.datasets.find(item=>item.id===task.datasetId);return`<div class="section-heading"><div><h2>${esc(task.displayName)}</h2><p class="form-note">${esc(state.projects.find(project=>project.id===task.projectId)?.displayName||'')}</p></div>${button('task-return',task.id,'Back to project')}</div><nav class="task-page-navigation" aria-label="Task sections">${button('task-settings',task.id,'Details & processing',state.taskPage==='settings')}${button('task-files',task.id,'Files & versions',state.taskPage==='files')}${can('viewer.gcp.read')?button('task-gcp',task.id,'Ground control points',state.taskPage==='gcp'):''}</nav><section class="task-workspace-page">${taskWorkspaceBody(task,dataset)}</section>`}
function attemptLabel(item,currentId){return`Run #${available(item.attemptNumber||item.attempt_number||'?')}${item.id===currentId?' · current':''}`}
function stageName(value){return String(value||'unknown').replaceAll('_',' ').replaceAll('.',' › ')}
function diagnosticJobLines(job){const lines=[job.result?.summary||job.summary||job.errorMessage||job.result?.error||'No additional detail'];if(job.queueReason)lines.push(`Queue: ${stageName(job.queueReason)}`);if(job.availableAt)lines.push(`Available: ${dateTime(job.availableAt)}`);if(job.heartbeatAt)lines.push(`Heartbeat: ${dateTime(job.heartbeatAt)}`);if(Number.isFinite(job.attemptCount))lines.push(`Worker attempts: ${job.attemptCount}`);if(job.input){lines.push(`Derivative input: ${bytes(job.input.byteSize)} across ${job.input.fileCount} files · limit ${bytes(job.input.limitBytes)} · reserved ${bytes(job.input.reservationBytes)}`);const roles=Object.entries(job.input.roleBreakdown||{}).map(([role,value])=>`${stageName(role)} ${value.fileCount} / ${bytes(value.byteSize)}`);if(roles.length)lines.push(`Roles: ${roles.join(', ')}`)}const evidence=job.auditEvidence;if(evidence?.metric)lines.push(`Audit: ${stageName(evidence.metric)} observed ${evidence.observed} · limit ${evidence.limit}${evidence.grayZoneLimit===undefined?'':` · gray-zone ceiling ${evidence.grayZoneLimit}`}`);if(evidence?.acceptance)lines.push(`Audit acceptance: ${stageName(evidence.acceptance)}${evidence.policyRevision?` · ${evidence.policyRevision}`:''}`);return lines}
function attemptDiagnosticPanel(diagnostic,item,panelId,retryAction,retryAttributes=''){if(!diagnostic)return'';if(diagnostic.loading)return`<div class="attempt-diagnostic" id="${esc(panelId)}" role="status">Loading run diagnostics…</div>`;if(diagnostic.error)return`<div class="attempt-diagnostic load-error" id="${esc(panelId)}" role="alert"><strong>Run diagnostics could not be loaded</strong><p>${esc(diagnostic.error)}</p>${button(retryAction,item.id,'Retry',false,`${retryAttributes} aria-controls="${esc(panelId)}"`)}</div>`;const events=diagnostic.events||[],jobs=[...(diagnostic.processingJobs||[]),...(diagnostic.derivativeJobs||diagnostic.derivatives||[]),...(diagnostic.operations||[])],failure=diagnostic.errorDetail||events.find(event=>(event.state||event.status)==='failed'||event.severity==='error')||item.errorMessage&&{errorCode:item.errorCode,errorMessage:item.errorMessage,stage:item.status},logs=diagnostic.logs||[];return`<div class="attempt-diagnostic" id="${esc(panelId)}"><div class="attempt-diagnostic-grid">${failure?`<section class="diagnostic-error" role="alert"><p class="eyebrow">Failure details</p><strong>${esc(failure.errorCode||failure.code||'processing_failed')}</strong><p>${esc(failure.errorMessage||failure.summary||failure.message||item.errorMessage||'This run failed without a diagnostic summary.')}</p><small>Stage: ${esc(stageName(failure.stage||failure.phase||failure.type||item.status))}${failure.diagnosticId?` · Diagnostic ID: ${esc(failure.diagnosticId)}`:''}</small></section>`:''}<section><h4>Stage timeline</h4><ol class="stage-timeline">${events.map(event=>{const eventState=event.state||event.status||(event.severity==='error'?'failed':event.severity==='warning'?'warning':'progress');return`<li class="${esc(eventState)}"><span aria-hidden="true"></span><div><strong>${esc(stageName(event.stage||event.phase||event.type||event.eventType))}</strong><small>${dateTime(event.createdAt)} · ${esc(stageName(eventState))}</small>${event.summary||event.message?`<p>${esc(event.summary||event.message)}</p>`:''}${typeof event.details?.reason==='string'?`<p>Cleanup reason: ${esc(event.details.reason)}</p>`:''}</div></li>`}).join('')||`<li><div><strong>No stage events recorded</strong><small>The run state is ${esc(stageName(item.status))}.</small></div></li>`}</ol></section><section><h4>Jobs and derivatives</h4><div class="diagnostic-job-list">${jobs.map(job=>`<div><strong>${esc(stageName(job.type||job.jobType||job.operationType))}</strong>${badge(job.status)}${diagnosticJobLines(job).map(line=>`<small>${esc(line)}</small>`).join('')}</div>`).join('')||empty('No job details were recorded for this run.')}</div></section></div>${canRecoverExistingResult(diagnostic,can('viewer.processing.write'))?`<section class="attempt-recovery"><p>Retry importing the existing result without restarting the provider run.</p>${button('recover-existing-result',item.id,'Recover existing result',false,retryAttributes)}</section>`:''}<section class="attempt-log-section"><h4>Sanitized run output</h4>${logs.length?`<pre class="log-tail">${esc(logs.map(log=>`[${log.createdAt||''}] ${String(log.level||'info').toUpperCase()} ${log.message||''}`).join('\n'))}</pre>`:empty('No retained log output for this run.')}${diagnostic.logsTruncated?`<p class="form-note">Older output is unavailable because this log was truncated or aged out after ${esc(diagnostic.logRetentionDays||'the configured retention period')}.</p>`:''}</section></div>`}
function attemptHistory(taskId,attempts,currentId,allowRetry=true){const detail=state.taskDetails[taskId]||{},more=Boolean(detail.nextAttemptCursor);return`<details class="task-subsection task-disclosure attempt-history" ${disclosureAttributes(taskId,'history')}><summary><span>Processing history (${attempts.length}${more?'+':''})</span><small>Every recorded run</small></summary><div class="task-disclosure-body data-list">${attempts.map(item=>{const selected=detail.selectedAttemptId===item.id,panelId=`attempt-diagnostic-${item.id}`,providerRetry=Boolean(item.providerId);return`<article class="attempt-run ${selected?'selected':''}" data-attempt-id="${esc(item.id)}"><div class="attempt-run-heading"><div><strong>${attemptLabel(item,currentId)}</strong><small>${dateTime(item.createdAt)} · ${duration(item)}${item.providerTaskId?` · Provider task ${esc(item.providerTaskId)}`:''}</small>${item.errorMessage?`<small class="attempt-error-summary">${esc(item.errorCode||'processing_failed')}: ${esc(item.errorMessage)}</small>`:''}${!providerRetry&&['failed','cancelled'].includes(item.status)?'<small>Imported runs are retried from their owning import or required-derivative operation.</small>':''}</div>${badge(item.status)}<div class="row-actions">${button('open-attempt-diagnostics',item.id,selected?'Hide details':'View diagnostics',false,`data-task-id="${esc(taskId)}" aria-expanded="${selected}" aria-controls="${esc(panelId)}"`)}${allowRetry&&providerRetry&&can('viewer.processing.write')&&['failed','cancelled'].includes(item.status)?button('retry-attempt',item.id,'Retry provider run'):''}</div></div>${selected?attemptDiagnosticPanel(detail.attemptDiagnostics?.[item.id],item,panelId,'retry-attempt-diagnostics',`data-task-id="${esc(taskId)}"`):''}</article>`}).join('')||empty('No processing attempts have been recorded.')}${more?`<div class="history-load-more">${button('load-more-attempts',taskId,'Load older runs')}</div>`:''}</div></details>`}
function durationFromMs(value){if(!Number.isSafeInteger(value)||value<0)return'Unavailable';const total=Math.round(value/1000),hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60);return hours?`${hours}h ${minutes}m`:`${minutes}m ${total%60}s`}
function activeTaskAction(task,attempt){if(!can('viewer.processing.write')||task.status==='archived')return'';if(LIVE_ATTEMPT_STATUSES.has(attempt.status))return button('cancel-attempt',attempt.id,'Cancel');if(attempt.providerId&&['failed','cancelled'].includes(attempt.status))return button('retry-attempt',attempt.id,'Restart provider run',true);if(attempt.providerId)return button('restart-task',task.id,'Restart',false);return''}
function gcpWorkspace(taskId){return state.gcpWorkspaces[taskId]||(state.gcpWorkspaces[taskId]={setId:null,pointId:null,mode:'auto',radiusM:100,activeImage:null,imageUrl:null,draftPixel:null,editingId:null,pointCache:{}})}
function gcpImageName(image){return String(image?.relativePath||image?.id||'Image').split('/').at(-1)}
function gcpPointName(point){return point?.label||point?.externalId||point?.id||'Unknown point'}
function gcpMarkerStyle(workspace){const image=workspace.activeImage,pixel=workspace.draftPixel;if(!image||!pixel||!Number(image.width)||!Number(image.height))return'';return`left:${Math.max(0,Math.min(100,pixel.pixelX/image.width*100))}%;top:${Math.max(0,Math.min(100,pixel.pixelY/image.height*100))}%`}
function gcpPanel(task,dataset,gcp){if(!dataset||dataset.id!==task.datasetId)return empty('The linked source dataset is unavailable.');const canWrite=can('viewer.gcp.write')&&task.status!=='archived';const sets=gcp.sets||[],points=gcp.points||[],candidates=gcp.candidates||[],correspondences=gcp.correspondences||[],ranking=gcp.ranking,workspace=gcpWorkspace(task.id),selectedSet=sets.find(set=>set.id===workspace.setId),selectedPoint=points.find(point=>point.id===workspace.pointId),active=workspace.activeImage,activeMark=correspondences.find(mark=>mark.pointId===workspace.pointId&&mark.imageFileId===active?.id),pointById=new Map(points.map(point=>[point.id,point])),imageById=new Map(candidates.map(image=>[image.id,image]));const correspondenceRows=correspondences.slice(0,100).map(mark=>{const point=pointById.get(mark.pointId),image=imageById.get(mark.imageFileId);return`<div class="gcp-mark-row"><div><strong>${esc(gcpPointName(point))}</strong><small>${esc(gcpImageName(image||{id:mark.imageFileId}))} · x ${esc(mark.pixelX)}, y ${esc(mark.pixelY)}</small></div>${canWrite?`<div class="row-actions">${button('gcp-edit-mark',mark.id,'Edit',false,`data-task-id="${esc(task.id)}"`)}${button('gcp-delete-mark',mark.id,'Delete',false,`data-task-id="${esc(task.id)}"`)}</div>`:''}</div>`}).join('');const candidateRows=candidates.map(image=>{const marked=correspondences.some(mark=>mark.pointId===workspace.pointId&&mark.imageFileId===image.id),distance=Number.isFinite(image.distanceM)?`${image.distanceM.toFixed(image.distanceM<100?1:0)} m away`:'Capture-time order';return`<button class="gcp-candidate ${active?.id===image.id?'active':''}" data-action="gcp-open-image" data-id="${esc(image.id)}" data-task-id="${esc(task.id)}" aria-pressed="${active?.id===image.id}"><span><strong>${esc(gcpImageName(image))}</strong><small>${esc(distance)}${image.width&&image.height?` · ${image.width}×${image.height}`:''}</small></span>${marked?badge('marked'):''}</button>`}).join('');return`<section class="task-subsection"><div class="subsection-heading"><div><h3>Ground control points</h3><p>Import authoritative survey points, rank nearby camera positions, and mark the visible point in each source image.</p></div><span>${sets.reduce((sum,set)=>sum+(Number(set.pointCount)||0),0)} points · ${correspondences.length} marks</span></div>${canWrite?`<details class="gcp-import-disclosure"><summary>Import another control-point set</summary><form class="manage-form gcp-import-form" data-dataset-id="${esc(dataset?.id||'')}" data-task-id="${esc(task.id)}">${field('Set name','displayName','required maxlength="160"')}<label><span>Survey file</span><input name="file" type="file" accept=".csv,.geojson,.json" required></label><label><span>Format</span><select name="format" required><option value="emlid-all-columns-v1">Emlid all-columns CSV</option><option value="generic-csv-v1">Generic CSV v1</option><option value="generic-geojson-v1">Generic GeoJSON v1</option></select></label><button class="secondary-button">Preview GCP import</button><p class="form-note">For Emlid exports, the server derives the exact coordinate system and units from CS name. Review that provenance before import; ambiguous files are rejected instead of guessed.</p></form></details>`:'<p class="form-note">Read-only ground-control access. Importing and editing require additional permission.</p>'}${gcp.error?`<p class="gcp-warning" role="alert">${esc(gcp.error)}</p>`:''}${sets.length?`<div class="gcp-marker-workspace"><aside class="gcp-controls"><label><span>Control-point set</span><select class="gcp-set-select" data-task-id="${esc(task.id)}">${sets.map(set=>`<option value="${esc(set.id)}" ${set.id===workspace.setId?'selected':''}>${esc(set.displayName)} (${set.pointCount})</option>`).join('')}</select></label>${selectedSet?`<p class="gcp-provenance"><strong>${esc(selectedSet.crs||'CRS unavailable')}</strong><span>${esc(selectedSet.provenance?.coordinateSystem||selectedSet.crs||'Coordinate system unavailable')}</span><span>${esc(selectedSet.provenance?.verticalDatum||'Vertical datum unavailable')} · ${esc(selectedSet.provenance?.linearUnit||selectedSet.elevationUnits||'units unavailable')}</span></p>`:''}<label><span>Control point</span><select class="gcp-point-select" data-task-id="${esc(task.id)}">${points.map(point=>`<option value="${esc(point.id)}" ${point.id===workspace.pointId?'selected':''}>${esc(gcpPointName(point))}</option>`).join('')}</select></label>${selectedPoint?`<dl class="gcp-point-detail"><div><dt>Latitude</dt><dd>${esc(selectedPoint.latitude)}</dd></div><div><dt>Longitude</dt><dd>${esc(selectedPoint.longitude)}</dd></div><div><dt>Elevation</dt><dd>${esc(selectedPoint.elevationM)} m</dd></div></dl>`:''}<form class="gcp-candidate-form" data-task-id="${esc(task.id)}"><label><span>Image suggestions</span><select name="mode"><option value="auto" ${workspace.mode==='auto'?'selected':''}>Auto radius</option><option value="radius" ${workspace.mode==='radius'?'selected':''}>Fixed radius</option><option value="nearest" ${workspace.mode==='nearest'?'selected':''}>Nearest images</option></select></label>${workspace.mode==='radius'?field('Radius (metres)','radiusM',`type="number" min="0.1" max="100000" step="0.1" required value="${esc(workspace.radiusM)}"`):''}<button class="secondary-button">Refresh suggestions</button></form>${ranking?`<div class="gcp-ranking"><p>${esc(ranking.notice)}</p><small>${esc(ranking.mode)}${Number.isFinite(ranking.radiusM)?` · ${ranking.radiusM.toFixed(1)} m`:''} · visibility not confirmed</small>${(ranking.warnings||[]).map(warning=>`<span class="gcp-warning">${esc(warning)}</span>`).join('')}</div>`:''}<div class="gcp-candidates" aria-label="Suggested source images">${candidateRows||empty(selectedPoint?'No candidate images were found.':'Select a control point.')}</div></aside><div class="gcp-image-column">${active&&workspace.imageUrl?`<figure class="gcp-image-figure"><div class="gcp-image-stage"><img class="gcp-mark-image" src="${esc(workspace.imageUrl)}" alt="${esc(gcpImageName(active))}" data-task-id="${esc(task.id)}" draggable="false"><span class="gcp-marker" style="${gcpMarkerStyle(workspace)}" ${workspace.draftPixel?'':'hidden'} aria-hidden="true"></span></div><figcaption>${canWrite?'Click the visible control point in the image, or enter exact pixel coordinates below.':'Source image preview — read only.'}</figcaption></figure>${canWrite?`<form class="manage-form gcp-mark-form" data-task-id="${esc(task.id)}"><input type="hidden" name="imageFileId" value="${esc(active.id)}"><div class="gcp-pixel-fields">${field('Pixel X','pixelX',`type="number" min="0" step="any" required value="${esc(workspace.draftPixel?.pixelX??'')}"`)}${field('Pixel Y','pixelY',`type="number" min="0" step="any" required value="${esc(workspace.draftPixel?.pixelY??'')}"`)}</div><button class="primary-button">${workspace.editingId||activeMark?'Update mark':'Save mark'}</button></form>`:''}`:workspace.imageLoading?empty('Loading the private source image…'):empty(selectedPoint?'Select a suggested image to mark.':'Select a control point first.')}<section class="gcp-mark-list"><h4>Saved correspondences</h4>${correspondenceRows||empty('No image marks saved for this task.')}${correspondences.length>100?'<p class="form-note">Showing the first 100 saved marks.</p>':''}</section></div></div>`:empty('Import a GCP set to begin marking source images.')}</section>`}
function outputPanel(task,attempt,outputs,allowMutations=true){return`<section class="task-subsection"><div class="subsection-heading"><div><h3>Model files</h3><p>Actions appear only when the API reports the corresponding integrity-checked artifact.</p></div></div><div class="data-list">${outputs.map(output=>`<div class="manage-row output-row"><div><strong>${esc(output.displayName||task.displayName)}</strong><small>${bytes(output.byteSize)} · ${output.assetCount??0} assets</small></div>${badge(output.status)}<div class="row-actions">${artifactActions(output,allowMutations)}${allowMutations&&canShareOutput(output)?button('share-output',output.id,'Share'):''}</div></div>`).join('')||empty('No output is available yet.')}</div></section>`}
function artifactActions(output,allowMutations=true){const kinds=new Set(Array.isArray(output.assetKinds)?output.assetKinds:[]),items=[];if(output.status==='published'&&output.viewSessionUrl)items.push(button('view-output',output.id,kinds.has('tiles')||kinds.has('ept')||kinds.has('glb')?'Open 3D model':'Open map',true));else if(allowMutations&&output.status==='ready'&&output.attemptId&&can('viewer.processing.publish'))items.push(button('open-review',output.attemptId,'View'));if(allowMutations){const lod=lodAction(output);if(lod)items.push(lod)}if(output.downloadProducts?.length||output.downloadUrl&&kinds.size)items.push(button('download-output',output.id,'Download',false,`data-url="${esc(output.downloadUrl)}"`));if(output.reportUrl&&kinds.has('report'))items.push(button('download-report',output.id,'Model report',false,`data-url="${esc(output.reportUrl)}"`));if(allowMutations&&['ready','published','failed','archived'].includes(output.status)&&can('viewer.processing.publish'))items.push(dangerButton('trash-output',output.id,'Delete'));return items.join('')}
function taskOutputStage(attempt,logs){const labels={odm_load_dataset:'Loading photos',dataset:'Loading photos',split:'Splitting dataset',merge:'Merging submodels',opensfm:'Camera reconstruction',openmvs:'Dense reconstruction',odm_filterpoints:'Filtering point cloud',odm_meshing:'Building mesh',odm_texturing:'Texturing model',odm_georeferencing:'Georeferencing',odm_dem:'Elevation models',odm_orthophoto:'Orthophoto',odm_report:'Quality report',odm_postprocess:'Finalizing outputs'},viewerStages={ingesting:'Viewer is ingesting completed results',derivatives:'Viewer is preparing derived outputs'};if(viewerStages[attempt.status])return viewerStages[attempt.status];if(!['running','queued_upstream'].includes(attempt.status))return String(attempt.status||'unknown').replaceAll('_',' ');for(const log of [...logs].reverse()){const match=String(log.message||'').replace(/\x1b\[[0-9;]*m/g,'').match(/\b(?:running|starting)\s+(?:(?:stage|step)\s*[:=]?\s*)?[\x22\x27]?(odm_[a-z]+|opensfm|openmvs|dataset|split|merge)\b/i);if(match&&labels[match[1].toLowerCase()])return labels[match[1].toLowerCase()]}return attempt.status==='queued_upstream'?'Waiting for processing node':'Processing — stage not reported in recent output'}
function logPanel(task,attempt,logs=[]){if(!can('viewer.processing.read')||!attempt.id)return'';const queued=attempt.status==='queued_upstream',running=attempt.status==='running',live=LIVE_ATTEMPT_STATUSES.has(attempt.status),detail=state.taskDetails[task.id],text=logs.map(log=>`[${log.createdAt||''}] ${String(log.level||'info').toUpperCase()} ${log.message||''}`).join('\n'),progress=running&&typeof attempt.progress==='number'&&Number.isFinite(attempt.progress)?Math.max(0,Math.min(1,attempt.progress)):null,refreshMessage=queued?'Coordinator queued this task; waiting for a processing node.':attempt.status==='ingesting'?'Processing node finished; Viewer is ingesting completed results.':attempt.status==='derivatives'?'Viewer is preparing derived outputs after node processing.':running?'Processing node is running; live output refreshes every five seconds.':live?'Viewer is preparing this task; output refreshes every five seconds.':'Latest saved output.';return`<section class="task-subsection task-live-output" data-task-output="${esc(task.id)}"><div class="subsection-heading"><div><h3>Task output</h3><p>${refreshMessage} Latest 100 recorded lines.</p></div><div class="row-actions"><button class="secondary-button" data-action="download-logs" data-id="${esc(task.id)}">Download tail</button><button class="secondary-button" data-action="fullscreen-logs" data-id="${esc(task.id)}">Fullscreen</button></div></div><div class="task-output-status" role="status"><strong>${esc(taskOutputStage(attempt,logs))}</strong>${progress!==null?`<span>${Math.round(progress*100)}% reported by processing node</span><progress max="1" value="${progress}" aria-label="Processing node progress"></progress>`:''}</div>${detail?.logsError?'<p class="form-note" role="status">Output could not be refreshed. Showing the last available output; retrying while this task is active.</p>':''}<pre class="log-tail" tabindex="0" aria-label="Latest task output">${esc(text||'Waiting for recorded task output…')}</pre></section>`}

const providerName=type=>type==='clusterodm'?'ClusterODM':type==='nodeodm'?'NodeODM':'Unavailable';
const optionValue=value=>value===undefined||value===null?'Unavailable':typeof value==='string'?value:JSON.stringify(value);
function providers(){
  if(!can('viewer.providers.read'))return empty('You do not have access to processing nodes.');
  if(state.selectedProviderId!=='__new__'&&!state.providers.some(provider=>provider.id===state.selectedProviderId))state.selectedProviderId=state.providers[0]?.id||null;
  const selected=state.providers.find(provider=>provider.id===state.selectedProviderId),write=can('viewer.providers.write');
  return `<div class="section-heading"><div><p class="eyebrow">Infrastructure</p><h2>Providers & nodes</h2><p>Select a node to inspect its health, processing capabilities, and presets.</p></div></div><div class="provider-master-detail provider-workspace"><aside aria-label="Processing nodes">${write?'<button class="secondary-button provider-add" data-action="provider-new">+ Add node</button>':''}<div class="provider-list" aria-label="Available processing nodes">${state.providers.map(provider=>`<button class="provider-list-item ${provider.id===state.selectedProviderId?'active':''}" data-action="select-provider" data-id="${esc(provider.id)}" aria-pressed="${provider.id===state.selectedProviderId}" aria-controls="provider-inline-detail"><span><strong>${esc(provider.displayName)}</strong><small>${esc(provider.endpoint)}</small></span>${badge(provider.runtimeHealth||provider.lastHealth||'not probed')}</button>`).join('')||empty('No nodes yet.')}</div></aside><section id="provider-inline-detail" aria-label="Selected processing node">${selected?providerDetail(selected):state.selectedProviderId==='__new__'&&write?providerForm():empty(write?'Add a processing node to get started.':'No processing nodes are configured.')}</section></div>`;
}
function providerModal(selectedId=state.selectedProviderId,activate=false){
  if(!can('viewer.providers.read'))return;
  if(selectedId==='__new__'&&!can('viewer.providers.write'))return;
  const scroll=content.querySelector('.provider-list')?.scrollTop||0;
  state.selectedProviderId=selectedId==='__new__'?'__new__':selectedId||state.providers[0]?.id||null;
  lastProviderEntry=null;
  // A completed save must not pull the user back after they navigate away.
  if(state.section!=='providers'){if(activate)navigateWorkspace({section:'providers'},'push');return;}else render();
  const list=content.querySelector('.provider-list');if(list)list.scrollTop=scroll;
}
const providerCapabilityRefreshes=new Map();
const providerCapabilityStatus=new Map();
let lastProviderEntry=null;
function providerCapabilityNotice(provider){const status=providerCapabilityStatus.get(provider.id);return status?.loading?'Refreshing current node capabilities…':status?.error?`Cached capabilities · refresh failed: ${status.error}`:status?.checkedAt?`Capabilities refreshed ${dateTime(status.checkedAt)}`:'Cached capabilities · not refreshed in this visit'}
async function refreshProviderCapabilities(id){
  if(!id||id==='__new__'||!can('viewer.providers.read'))return false;
  if(providerCapabilityRefreshes.has(id))return providerCapabilityRefreshes.get(id);
  const pending=(async()=>{providerCapabilityStatus.set(id,{loading:true});try{
    await api(`/api/v1/processing/providers/${encodeURIComponent(id)}/capabilities/refresh`,{method:'POST',body:{}});
    const [nodes,presets]=await Promise.all([api('/api/v1/processing/providers?limit=100'),can('viewer.processing.read')?api('/api/v1/processing/presets'):Promise.resolve({presets:state.presets})]);
    state.providers=nodes.providers||state.providers;state.presets=presets.presets||state.presets;
    providerCapabilityStatus.set(id,{checkedAt:new Date().toISOString()});return true;
  }catch(error){providerCapabilityStatus.set(id,{error:error.message});return false}
  finally{providerCapabilityRefreshes.delete(id);if(state.section==='providers')render();}})();
  providerCapabilityRefreshes.set(id,pending);return pending;
}
function refreshOpenedProvider(){
  if(state.section!=='providers'){lastProviderEntry=null;return}
  if(state.selectedProviderId===lastProviderEntry)return;
  lastProviderEntry=state.selectedProviderId;
  void refreshProviderCapabilities(lastProviderEntry);
}
function providerDetail(provider){
  const capabilities=provider.capabilities||{},presets=state.presets.filter(preset=>preset.providerType===provider.type),write=can('viewer.providers.write');
  return `<div class="provider-detail"><p class="eyebrow">Detected ${providerName(provider.type)}</p><h3>${esc(provider.displayName)}</h3><p class="form-note" role="status">${esc(providerCapabilityNotice(provider))}</p><dl class="detail-list"><div><dt>Endpoint</dt><dd>${esc(provider.endpoint)}</dd></div><div><dt>API token</dt><dd>${provider.credential?.mode==='none'?'Not required':provider.credential?.configured?'Configured · hidden':'Not configured'}</dd></div><div><dt>API version</dt><dd>${available(capabilities.apiVersion)}</dd></div><div><dt>Processing engine</dt><dd>${available(capabilities.engine)} · ${available(capabilities.engineVersion)}</dd></div><div><dt>Queue</dt><dd>${capabilities.taskQueueCount??'Unavailable'} queued · ${capabilities.maxParallelTasks===99999999999?'Cluster-managed capacity':`${esc(capabilities.maxParallelTasks??'Unavailable')} upstream slots`}</dd></div><div><dt>Viewer upload admission</dt><dd>${provider.admissionLimit} concurrent task upload${provider.admissionLimit===1?'':'s'}</dd></div><div><dt>Runtime health</dt><dd>${badge(provider.runtimeHealth||provider.lastHealth||'not probed')}</dd></div></dl><p class="form-note">This limit only gates Viewer work before the coordinator accepts a task. After commit, the coordinator owns its queued and running work; Viewer continues reporting that state.</p><section class="provider-options"><h4>Processing presets</h4>${write?`<div class="row-actions">${button('new-preset',provider.id,'Create preset')}${button('import-preset',provider.id,'Import preset')}</div>`:''}<div class="provider-option-list">${presets.map(preset=>`<div class="provider-option"><span><strong>${esc(preset.displayName)}</strong><small>${preset.builtIn?'Built in · read-only':preset.enabled?'Enabled':'Disabled'}${preset.capabilityFingerprint!==provider.capabilityFingerprint?' · capabilities changed — review required':''}</small></span><div class="row-actions">${button('view-preset',preset.id,'View')}${write?`${button('duplicate-preset',preset.id,'Duplicate')}${preset.builtIn?'':`${button('edit-preset',preset.id,'Edit')}${button('delete-preset',preset.id,'Delete')}`}`:''}</div></div>`).join('')||empty('No processing presets yet.')}</div></section>${write?`<div class="row-actions">${button('edit-provider',provider.id,'Edit node')}${button('replace-provider-token',provider.id,provider.credential?.configured?'Replace token':'Set token')}${provider.credential?.configured?button('clear-provider-token',provider.id,'Clear token'):''}${button('probe-provider',provider.id,'Refresh capabilities')}${button('toggle-provider',provider.id,provider.enabled?'Disable':'Enable',!provider.enabled,`data-enabled="${!provider.enabled}"`)}${dangerButton('remove-provider',provider.id,'Remove node')}</div>`:''}<p class="form-note">Secrets are write-only. Processing settings are edited in a preset or while scheduling a task.</p></div>`;
}
function providerForm(){return`<form id="provider-form" class="manage-form">${field('Node label','displayName','required maxlength="240"')}${field('HTTPS endpoint','endpoint','required type="url" placeholder="https://odm.example.com"')}${field('API token (if required)','token','type="password" autocomplete="new-password"')}<button class="primary-button">Detect & add node</button><p class="form-note">Viewer probes /info and /options, detects NodeODM or ClusterODM, and rejects unsupported or ambiguous endpoints. If supplied, the token is submitted once and is never displayed.</p></form>`}
function editProviderModal(id){const provider=state.providers.find(item=>item.id===id);if(!provider)return;openModal(`Edit ${provider.displayName}`,`<form id="provider-edit-form" class="manage-form"><input type="hidden" name="providerId" value="${esc(provider.id)}">${field('Node label','displayName',`required maxlength="240" value="${esc(provider.displayName)}"`)}${field('HTTPS endpoint','endpoint',`required type="url" value="${esc(provider.endpoint)}"`)}${field('Viewer task upload limit','admissionLimit',`required type="number" min="1" max="100" step="1" value="${esc(provider.admissionLimit)}"`)}<button class="primary-button">Save node</button><p class="form-note">This limits Viewer task submissions before coordinator acceptance; coordinator-queued and running jobs do not consume the limit. Changing the endpoint disables the node until its capabilities are probed again.</p></form>`);modalContent.querySelector('#provider-edit-form').onsubmit=async event=>{event.preventDefault();const input=values(event.currentTarget);modal.close();await mutate(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}`,{method:'PATCH',body:{displayName:input.displayName,endpoint:input.endpoint,admissionLimit:Number(input.admissionLimit)}},'Provider updated');providerModal(provider.id)}}
function providerTokenModal(id){const provider=state.providers.find(item=>item.id===id);if(!provider)return;openModal(`API token for ${provider.displayName}`,`<form id="provider-token-form" class="manage-form">${field('New API token','token','required type="password" autocomplete="new-password"')}<button class="primary-button">Store token</button><p class="form-note">The token is encrypted at rest, submitted once, and never displayed again.</p></form>`);modalContent.querySelector('#provider-token-form').onsubmit=async event=>{event.preventDefault();const token=event.currentTarget.elements.token.value;modal.close();await mutate(`/api/v1/processing/providers/${encodeURIComponent(provider.id)}/credential`,{method:'PUT',body:{token}},'Provider token stored');providerModal(provider.id)}}
let presetEditorGeneration=0;
async function presetModal(providerId,presetId=null,mode='edit',imported=null){
  const generation=++presetEditorGeneration;
  openModal('Processing preset','<p role="status">Refreshing node capabilities…</p>','workspace-task-modal');
  const loadingContext=modalContent.querySelector('[role="status"]');
  await refreshProviderCapabilities(providerId);
  if(generation!==presetEditorGeneration||!modal.open||!loadingContext?.isConnected)return;
  const provider=state.providers.find(item=>item.id===providerId),preset=state.presets.find(item=>item.id===presetId);
  if(!provider)return toast('The selected node is no longer available',true);
  const readOnly=mode==='view'||(preset?.builtIn&&mode!=='duplicate')||!can('viewer.providers.write'),source=imported||preset||{},baseOptions={...(source.options||{})};
  const editing=!!preset&&mode!=='duplicate',displayName=mode==='duplicate'?`${source.displayName||'Preset'} copy`:source.displayName||'';
  openModal(readOnly?'View processing preset':editing?'Edit processing preset':'Create processing preset',`<form id="preset-form" class="manage-form">${field('Preset name','displayName',`required maxlength="240" value="${esc(displayName)}" ${readOnly?'readonly':''}`)}${field('Description','description',`maxlength="1000" value="${esc(source.description||'')}" ${readOnly?'readonly':''}`)}<p class="form-note" role="status">${esc(providerCapabilityNotice(provider))}</p>${source.capabilityFingerprint&&source.capabilityFingerprint!==provider.capabilityFingerprint?'<p class="form-note">Node capabilities changed since this preset was saved. Review all settings; saving revalidates against current capabilities.</p>':''}<div id="preset-options-editor"></div><details><summary>Stored preset values (including unsupported settings)</summary><pre>${esc(JSON.stringify(baseOptions,null,2))}</pre><p class="form-note">Existing and imported values are retained, not silently dropped. Unsupported values are rejected by server validation.</p></details><label class="check"><input type="checkbox" name="enabled" ${source.enabled===false?'':'checked'} ${readOnly?'disabled':''}> Enabled</label>${readOnly?'':`<button class="primary-button" type="submit">${editing?'Save preset':'Create preset'}</button>`}<p id="preset-save-status" class="form-note" role="status"></p></form>`,'workspace-task-modal');
  const form=modalContent.querySelector('#preset-form'),editor=mountTaskOptions({container:form.querySelector('#preset-options-editor'),provider,presetOptions:baseOptions,title:'Processing options',helpText:'Edit this preset directly. Changes are stored only when you save the preset.',modifiedLabel:'Modified in this preset'});
  const detail=form.querySelector('.task-options-editor');if(detail)detail.open=true;editor.setDisabled(readOnly);
  if(!readOnly){
    const known=new Set((provider.capabilities?.options||[]).map(option=>option.name));
    const unsupported=Object.keys(baseOptions).filter(name=>!known.has(name));
    if(unsupported.length){
      const warning=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent='Unsupported stored options — explicitly remove to resolve';warning.append(legend);
      for(const name of unsupported){const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.addEventListener('change',()=>{if(checkbox.checked)delete baseOptions[name];else baseOptions[name]=source.options[name]});label.append(checkbox,document.createTextNode(` Remove ${name}: ${JSON.stringify(baseOptions[name])}`));warning.append(label)}
      form.querySelector('#preset-options-editor').append(warning);
    }
  }
  modal.addEventListener('close',()=>editor.dispose(),{once:true});
  let saving=false,saved=false;
  const saveReceipts=new Map();
  form.onsubmit=async event=>{
    event.preventDefault();if(readOnly||saving||saved||!form.isConnected||!modal.open||!can('viewer.providers.write'))return;
    const status=form.querySelector('#preset-save-status');
    let fields=[];
    try{
      const options={...baseOptions,...editor.getOptions()},body={displayName:form.elements.displayName.value,description:form.elements.description.value,providerId:provider.id,options,enabled:form.elements.enabled.checked};
      const identity=JSON.stringify(body);if(!saveReceipts.has(identity))saveReceipts.set(identity,crypto.randomUUID());
      saving=true;fields=[...form.querySelectorAll('input,select,textarea,button')].filter(element=>!element.closest('.task-options-editor')).map(element=>[element,element.disabled]);for(const [element] of fields)element.disabled=true;editor.setDisabled(true);status.textContent='Validating and saving preset…';
      await api(editing?`/api/v1/processing/presets/${encodeURIComponent(preset.id)}`:'/api/v1/processing/presets',{method:editing?'PATCH':'POST',body,headers:{'Idempotency-Key':saveReceipts.get(identity)}});
      saved=true;
      if(form.isConnected&&modal.open)modal.close();
      toast(editing?'Preset updated':'Preset created');
      try{await load()}catch(error){toast(`Preset saved; workspace refresh failed: ${error.message}`,true)}
    }catch(error){if(form.isConnected)status.textContent=error.message}
    finally{saving=false;if(!saved&&form.isConnected){for(const [element,disabled] of fields)element.disabled=disabled;editor.setDisabled(readOnly)}}
  };
}
function importPresetModal(providerId){
  openModal('Import processing preset','<form id="preset-import-form" class="manage-form"><label><span>Preset JSON file</span><input name="file" type="file" accept=".json,application/json" required></label><p class="form-note">Import one Viewer preset or a WebODM preset with name/value options. Review before saving.</p><button class="primary-button">Review preset</button><p role="status"></p></form>');
  const form=modalContent.querySelector('#preset-import-form');
  form.onsubmit=async event=>{event.preventDefault();try{
    const file=form.elements.file.files[0];if(!file||file.size>256*1024)throw new Error('Choose a preset JSON file smaller than 256 KB.');
    const value=JSON.parse(await file.text());if(!form.isConnected||!modal.open)return;if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Import one preset object.');
    let options=value.options;if(typeof options==='string')options=JSON.parse(options);
    if(Array.isArray(options)){const entries=options.map(option=>{if(!option||typeof option.name!=='string'||!Object.hasOwn(option,'value'))throw new Error('Each imported option needs a name and value.');return[option.name,option.value]});if(new Set(entries.map(([name])=>name)).size!==entries.length)throw new Error('Duplicate option names are not allowed.');options=Object.fromEntries(entries)}
    if(!options||Array.isArray(options)||typeof options!=='object')throw new Error('The preset must contain an options object or name/value array.');
    return presetModal(providerId,null,'create',{displayName:value.displayName||value.name||file.name.replace(/\.json$/i,''),description:value.description||'',options});
  }catch(error){form.querySelector('[role="status"]').textContent=error.message}};
}

function trash(){if(state.trashLoadError)return`<section class="content-card load-error" role="alert"><p class="eyebrow">Recycle Bin unavailable</p><h2>Deleted items could not be loaded</h2><p>${esc(state.trashLoadError)}</p>${button('retry-trash-load','trash','Try again',true)}</section>`;const items=state.storage?.trash?.items||[],order=['project','task','dataset','output'],groups=order.map(type=>[type,items.filter(item=>item.entityType===type)]).filter(([,rows])=>rows.length),totalBytes=items.reduce((sum,item)=>sum+(Number(item.byteSize)||0),0),nextPurge=items.map(item=>Date.parse(item.purgeAfter||'')).filter(Number.isFinite).sort((a,b)=>a-b)[0];const sections=groups.map(([type,rows])=>`<section class="trash-group" aria-labelledby="trash-${esc(type)}"><div class="trash-group-heading"><h2 id="trash-${esc(type)}">${esc(type[0].toUpperCase()+type.slice(1))}s</h2><span>${rows.length} item${rows.length===1?'':'s'} · ${bytes(rows.reduce((sum,item)=>sum+(Number(item.byteSize)||0),0))}</span></div><div class="data-list">${rows.map(item=>`<article class="manage-row trash-row"><div><strong>${esc(item.displayName||item.entityType)}</strong><small>${esc(item.entityType)} ID: ${esc(item.entityId)}</small><small>${bytes(item.byteSize)} · Permanently deletes after ${dateTime(item.purgeAfter)}</small></div>${badge('trash')}<div class="row-actions">${can('viewer.storage.purge')?`${button('restore-trash',item.id,'Restore')}${dangerButton('purge-trash',item.id,'Delete permanently',`data-entity-id="${esc(item.entityId)}"`)}`:'Recovery controls require storage lifecycle permission.'}</div></article>`).join('')}</div></section>`).join('');return`<div class="metric-grid trash-summary">${metric('Deleted items',items.length,'Across projects, tasks, datasets, and outputs')}${metric('Recoverable data',bytes(totalBytes),'Recorded size in the Recycle Bin')}${metric('Next automatic purge',nextPurge?new Date(nextPurge).toLocaleDateString():'None scheduled','Restore before this date')}${metric('Retention',items.length?'Active':'Clear',items.length?'Items remain recoverable until their purge date':'No deleted items are waiting')}</div><div class="recycle-bin top-gap"><div class="section-heading"><div><p class="eyebrow">Storage recovery</p><h2>Recycle Bin</h2><p class="card-copy">Restore deleted work or permanently remove it after verifying the exact identifier. Permanent deletion cannot be undone.</p></div></div>${sections||empty('The Recycle Bin is empty.')}</div>`}
function globalDiagnosticRun(item){const selected=state.selectedDiagnosticRunId===item.attemptId,panelId=`global-attempt-diagnostic-${item.attemptId}`,display={...item,id:item.attemptId,errorCode:item.error?.code,errorMessage:item.error?.message};return`<article class="attempt-run ${selected?'selected':''}" data-diagnostic-attempt-id="${esc(item.attemptId)}"><div class="attempt-run-heading"><div><strong>${attemptLabel(display)}</strong><small>${dateTime(item.createdAt)} · ${esc(stageName(item.phase||item.status))}</small>${display.errorMessage?`<small class="attempt-error-summary">${esc(display.errorCode||'processing_failed')}: ${esc(display.errorMessage)}</small>`:''}${Number.isFinite(item.derivativeCount)?`<small>${item.derivativeCount} derivative${item.derivativeCount===1?'':'s'}${item.failedDerivativeCount?` · ${item.failedDerivativeCount} failed`:''}</small>`:''}</div>${badge(item.status)}<div class="row-actions">${button('open-global-attempt-diagnostics',item.attemptId,selected?'Hide details':'View diagnostics',false,`aria-expanded="${selected}" aria-controls="${esc(panelId)}"`)}</div></div>${selected?attemptDiagnosticPanel(state.diagnosticDetails[item.attemptId],display,panelId,'retry-global-attempt-diagnostics'):''}</article>`}
function globalDiagnosticHistory(){if(state.diagnosticRunsError&&!state.diagnosticRuns.length)return`<section class="content-card diagnostic-run-history load-error" role="alert"><p class="eyebrow">Processing run history unavailable</p><h2>Runs could not be loaded</h2><p>${esc(state.diagnosticRunsError)}</p>${button('retry-diagnostic-runs','diagnostics','Try again',true)}</section>`;const projects=new Map();for(const run of state.diagnosticRuns){const projectKey=run.projectId||'unassigned-project',taskKey=run.taskId||'unassigned-task';if(!projects.has(projectKey))projects.set(projectKey,{name:run.projectDisplayName||'Unassigned project',tasks:new Map()});const project=projects.get(projectKey);if(!project.tasks.has(taskKey))project.tasks.set(taskKey,{name:run.taskDisplayName||'Unassigned task',runs:[]});project.tasks.get(taskKey).runs.push(run)}const groups=[...projects.entries()].map(([projectId,project])=>`<section class="diagnostic-project-group" aria-labelledby="diagnostic-project-${esc(projectId)}"><h3 id="diagnostic-project-${esc(projectId)}">${esc(project.name)}</h3>${[...project.tasks.entries()].map(([taskId,task])=>`<section class="diagnostic-task-group" aria-labelledby="diagnostic-task-${esc(taskId)}"><div class="diagnostic-task-heading"><h4 id="diagnostic-task-${esc(taskId)}">${esc(task.name)}</h4><span>${task.runs.length} run${task.runs.length===1?'':'s'}</span></div><div class="data-list">${task.runs.map(globalDiagnosticRun).join('')}</div></section>`).join('')}</section>`).join('');return`<section class="content-card diagnostic-run-history"><div class="section-heading"><div><p class="eyebrow">All projects</p><h2>Processing run history</h2><p>Inspect every retained attempt, failure stage, derivative, and sanitized log without opening each task.</p></div>${button('retry-diagnostic-runs','diagnostics','Refresh')}</div>${state.diagnosticRunsError?`<p class="load-error" role="alert">Older runs could not be loaded: ${esc(state.diagnosticRunsError)}</p>`:''}<div class="diagnostic-run-groups">${groups||(state.diagnosticRunsLoading?empty('Loading processing runs…'):empty('No processing runs have been recorded.'))}</div>${state.diagnosticRunsCursor?`<div class="history-load-more">${button('load-more-diagnostic-runs','diagnostics',state.diagnosticRunsLoading?'Loading…':'Load older runs',false,state.diagnosticRunsLoading?'disabled':'')}</div>`:''}</section>`}
function diagnostics(){const lifecycle=state.ready?.lifecycle||[],failed=state.failedMutations||[];const failedRows=failed.map(item=>`<div class="manage-row"><div><strong>${esc(item.type)} ${esc(item.entityType)}</strong><small>${esc(item.entityId)}</small><small>${esc(item.errorCode||'lifecycle_failed')}: ${esc(item.errorMessage||'The storage operation requires operator repair.')}</small></div>${badge(item.status)}<div class="row-actions">${can('viewer.storage.purge')?button('retry-storage-mutation',item.id,'Retry'):''}</div></div>`).join('')||empty('No failed storage mutations.');const trashCount=state.storage?.trash?.items?.length||0;return`<div class="metric-grid"><div id="storage-usage-cards" style="display:contents">${storageUsageCards(state.storage?.usage)}</div>${metric('Processing worker',state.ready?.worker?.live?'Live':'Unavailable','Queue and worker health')}${metric('Platform',state.ready?.ok?'Ready':'Attention needed','Aggregated readiness')}</div><div class="diagnostic-grid top-gap">${card('Queue & provider health',`<div class="data-list">${state.providers.map(provider=>`<div class="manage-row"><div><strong>${esc(provider.displayName)}</strong><small>${esc(provider.endpoint)}</small></div>${badge(provider.runtimeHealth||provider.lastHealth||'unknown')}<div></div></div>`).join('')||empty('No providers configured.')} ${lifecycle.map(item=>`<div class="manage-row"><div><strong>${esc(item.status)}</strong><small>Storage lifecycle operations</small></div><strong>${item.count}</strong><div></div></div>`).join('')}</div>`)}${card('Failed storage mutations',`<div class="data-list">${failedRows}</div><p class="form-note">Repair the reported storage conflict before retrying. A failed row keeps processing readiness blocked.</p>`)}${card('Storage trash & recovery',`${state.trashLoadError?`<p class="load-error" role="alert">Recycle Bin load failed: ${esc(state.trashLoadError)}</p>`:`<p class="card-copy">${trashCount} deleted item${trashCount===1?'':'s'} currently remain recoverable.</p>`}${button('open-trash','trash','Open Recycle Bin',true)}`)}</div><div class="top-gap">${globalDiagnosticHistory()}</div>`}

function render(){if(draggedFolderTask)clearTaskDrag();loadTreeState();const treeFocus=treeFocusKey();clearInterval(state.logTimer);renderNav();updateActivityIndicator();document.querySelector('#page-title').textContent=NAV.find(item=>item[0]===state.section)?.[2]||'Dashboard';if(state.taskPage)document.querySelector('#page-title').textContent={gcp:'Ground control points',settings:'Task settings',files:'Task files'}[state.taskPage];content.innerHTML=`<div id="workspace-section">${(state.section==='dashboard'&&state.taskPage?taskWorkspacePage:({dashboard,background,providers,trash,diagnostics}[state.section]||dashboard))()}</div>`;bind();syncTreeTabStop();restoreTreeFocus(treeFocus);if(state.section==='providers')bindModalActions(content.querySelector('.provider-workspace'));refreshOpenedProvider();bindTaskDisclosures();hydrateOrthophotoPreviews();storageUsagePoll.sync();scheduleProjectRefresh();if(state.expandedTaskId){const task=state.tasks.find(item=>item.id===state.expandedTaskId);if(LIVE_ATTEMPT_STATUSES.has(task?.latestAttempt?.status))state.logTimer=setInterval(()=>refreshTaskDetails(task.id,true),5000)}}
function bindProjectActions(root){root.querySelectorAll('[data-action]').forEach(element=>element.onclick=()=>action(element));}
function bind(){content.querySelectorAll('[data-section]').forEach(element=>element.onclick=()=>navigateWorkspace({section:element.dataset.section},'push'));bindProjectActions(content);const filter=content.querySelector('#project-filter');if(filter)filter.oninput=()=>{state.projectQuery=filter.value;const query=state.projectQuery.trim().toLocaleLowerCase('en-US');content.querySelectorAll('[data-project-name]').forEach(row=>row.hidden=Boolean(query&&!row.dataset.projectName.includes(query)))};const backgroundSearch=content.querySelector('#background-search-form');if(backgroundSearch)backgroundSearch.onsubmit=event=>{event.preventDefault();state.backgroundQuery=backgroundSearch.elements.query.value.trim();state.backgroundImportLimit=3;state.backgroundDerivativeLimit=3;render()};content.querySelectorAll('.gcp-import-form').forEach(form=>form.onsubmit=importGcp);content.querySelectorAll('.gcp-set-select').forEach(select=>select.onchange=()=>changeGcpSet(select.dataset.taskId,select.value));content.querySelectorAll('.gcp-point-select').forEach(select=>select.onchange=()=>changeGcpPoint(select.dataset.taskId,select.value));content.querySelectorAll('.gcp-candidate-form').forEach(form=>{form.elements.mode.onchange=()=>{gcpWorkspace(form.dataset.taskId).mode=form.elements.mode.value;render()};form.onsubmit=event=>refreshGcpCandidates(event)});content.querySelectorAll('.gcp-mark-form').forEach(form=>{form.onsubmit=saveGcpMark;form.oninput=()=>setGcpDraft(form.dataset.taskId,Number(form.elements.pixelX.value),Number(form.elements.pixelY.value))});content.querySelectorAll('.gcp-mark-image').forEach(image=>{image.onload=()=>configureGcpImage(image);image.onclick=event=>markGcpImage(event)})}
function expandTask(id){if(state.expandedTaskId)releaseGcpImage(gcpWorkspace(state.expandedTaskId));const opened=state.tasks.find(item=>item.id===id);if(opened&&opened.projectId!==state.selectedProjectId){state.selectedProjectId=opened.projectId;touchOpenProject(opened.projectId);saveTreeState();}state.expandedTaskId=id;state.taskDetails[id]={loading:true};syncWorkspaceView('push');render();animateOpenedTask(id);return refreshTaskDetails(id)}
async function action(element){
  const action=element.dataset.action,id=element.dataset.id,taskId=element.dataset.taskId;
  // A menu command closes its menu; focus waits on the menu button for the command to move it.
  // Unavailable menu items stay focusable (aria-disabled) so the arrow keys reach them, but do nothing.
  if(element.getAttribute('aria-disabled')==='true')return;
  const menu=element.getAttribute('role')==='menuitem'?element.closest('details.tree-menu'):null;
  if(menu){menu.open=false;menu.querySelector(':scope > summary')?.focus({preventScroll:true});}
  if(action==='new-project')return newProjectModal();
  if(['task-gcp','task-settings','task-files','task-return'].includes(action)){const task=state.tasks.find(item=>item.id===id);if(!task)return;return navigateWorkspace({section:'dashboard',selectedProjectId:task.projectId,expandedTaskId:task.id,taskPage:({'task-gcp':'gcp','task-settings':'settings','task-files':'files'})[action]||null},'push')}
  if(action==='task-history')return navigateWorkspace({section:'diagnostics'},'push');
  if(action==='folder-toggle')return toggleTreeFolder(element.dataset.projectId,id);
  if(action==='folder-retry')return loadProjectFolders(id);
  if(action==='folder-create')return startNewFolder(id,null);
  if(action==='folder-new')return startNewFolder(element.dataset.projectId,id);
  if(action==='tree-new-folder'){const target=treeNewFolderTarget();return target?startNewFolder(target.projectId,target.parentId):toast('Open a project to add a folder.',true);}
  if(action==='folder-rename')return startFolderRename(element.dataset.projectId,id);
  if(action==='folder-delete')return deleteFolder(element.dataset.projectId,id);
  if(action==='folder-move-task')return moveTaskFolderModal(id);
  if(action==='duplicate-task')return duplicateTask(id);
  if(action==='delete-task')return deleteTaskWithUndo(id);
  if(action==='open-project')return toggleTreeProject(id);
  if(action==='close-project')return toggleTreeProject(id,false);
  if(action==='edit-project')return editProject(id);
  if(action==='project-property-lines')return propertyLinesSourceModal(id);
  if(action==='trash-project')return trashMutation(`Delete this project and its owned tasks, datasets, and outputs? It can be restored until ${purgeDate(30)}; after that date it will be permanently purged.`, `/api/v1/projects/${encodeURIComponent(id)}`,'Project moved to Recycle Bin');
  if(action==='project-import'||action==='upload-dataset')return importModal(action==='upload-dataset'?null:id,action==='upload-dataset'?id:null);
  if(action==='project-process')return processModal(id);
  if(action==='project-share')return openShareModal(id);
  if(action==='trash-dataset')return trashMutation('Delete this dataset? It will remain recoverable in the Recycle Bin for 14 days.',`/api/v1/datasets/${encodeURIComponent(id)}`,'Dataset moved to Recycle Bin');
  if(action==='toggle-task')return state.expandedTaskId===id?collapseTask(id):expandTask(id);
  if(action==='gcp-open-image')return openGcpImage(taskId,id);
  if(action==='gcp-edit-mark')return editGcpMark(taskId,id);
  if(action==='gcp-delete-mark')return deleteGcpMark(taskId,id);
  if(action==='edit-task')return editTask(id);
  if(action==='trash-task')return deleteTaskWithUndo(id);
  if(action==='recover-existing-result'){const diagnostic=taskId?state.taskDetails[taskId]?.attemptDiagnostics?.[id]:state.diagnosticDetails[id];return recoverExistingResult(diagnostic,can('viewer.processing.write'),id,mutate,()=>{if(taskId){const detail=state.taskDetails[taskId];if(!detail)return;if(detail.attemptDiagnostics)delete detail.attemptDiagnostics[id];if(detail.selectedAttemptId===id)return loadTaskAttemptDiagnostics(taskId,id)}else{delete state.diagnosticDetails[id];if(state.selectedDiagnosticRunId===id)return loadGlobalAttemptDiagnostics(id)}},{getSession:()=>state.adminSession,onUncertain:()=>toast('Recovery status is uncertain. Diagnostics will refresh; retry uses the same request.',true),onHold:()=>toast('The recovery request needs manual review because its session or receipt window changed.',true)})}
  if(action==='cancel-attempt')return confirmCancelAttempt(id);
  if(action==='retry-attempt')return mutate(`/api/v1/attempts/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}},'Task restarted');
  if(action==='restart-task')return restartTask(id);
  if(action==='open-review')return openReview(id);
  if(action==='publish-attempt')return publishAttempt(id);
  if(action==='view-output')return viewPublishedOutput(id);
  if(action==='download-output'||action==='download-report')return downloadOutputAsset(id,element.dataset.url,action==='download-report');
  if(action==='share-output'){const output=state.outputs.find(item=>item.id===id),task=state.tasks.find(item=>item.id===output?.taskId);return openShareModal(task?.projectId||output?.projectId||state.selectedProjectId,id)}
  if(action==='trash-output')return trashMutation('Delete this output? Published assets will be unpublished and the output will remain recoverable in the Recycle Bin for 14 days. Active links or viewing sessions must be revoked first.',`/api/v1/processing/outputs/${encodeURIComponent(id)}`,'Output moved to Recycle Bin');
  if(action==='download-logs')return downloadLogs(id);
  if(action==='fullscreen-logs')return fullscreenLogs(id);
  if(action==='manage-providers')return providerModal(undefined,true);
  if(action==='open-provider')return providerModal(id,true);
  if(action==='retry-operation')return retryOperation(id);
  if(action==='retry-derivative')return retryDerivative(id);
  if(action==='generate-tiles')return generateTiles(id);
  if(action==='create-lod-recovery')return createLodRecovery(id,element.dataset.endpoint);
  if(action==='restore-products')return createCompanionRepair(id,element.dataset.endpoint);
  if(action==='load-more-background'){if(element.dataset.kind==='imports')state.backgroundImportLimit+=3;else state.backgroundDerivativeLimit+=3;return render()}
  if(action==='view-all-background'){if(element.dataset.kind==='imports')state.backgroundImportLimit=Number.MAX_SAFE_INTEGER;else state.backgroundDerivativeLimit=Number.MAX_SAFE_INTEGER;return render()}
  if(action==='clear-background-search'){state.backgroundQuery='';state.backgroundImportLimit=3;state.backgroundDerivativeLimit=3;return render()}
  if(action==='open-attempt-diagnostics')return toggleAttemptDiagnostics(taskId,id);
  if(action==='retry-attempt-diagnostics')return loadTaskAttemptDiagnostics(taskId,id);
  if(action==='open-global-attempt-diagnostics')return toggleGlobalAttemptDiagnostics(id);
  if(action==='retry-global-attempt-diagnostics')return loadGlobalAttemptDiagnostics(id);
  if(action==='retry-diagnostic-runs')return loadDiagnosticRuns(true);
  if(action==='load-more-diagnostic-runs')return loadDiagnosticRuns(false);
  if(action==='load-more-attempts')return loadMoreAttempts(id);
  if(action==='open-trash')return navigateWorkspace({section:'trash'},'push');
  if(action==='retry-trash-load')return refreshTrash();
  if(action==='retry-storage-mutation')return confirmedMutation('Retry this failed storage mutation after repairing the reported conflict?',`/api/v1/storage/mutations/${encodeURIComponent(id)}/retry`,{method:'POST',body:{}},'Storage mutation completed');
  if(action==='restore-trash')return mutate(`/api/v1/storage/trash/${encodeURIComponent(id)}/restore`,{method:'POST',body:{}},'Item restored');
  if(action==='purge-trash')return purgeTrash(id,element.dataset.entityId);
}

function normalizedAttemptDiagnostic(result){const diagnostic=result.diagnostics||result;return{...diagnostic,derivativeJobs:diagnostic.derivativeJobs||diagnostic.derivatives||[],operations:diagnostic.operations||(diagnostic.operation?[diagnostic.operation]:[])}}
async function loadTaskAttemptDiagnostics(taskId,attemptId){const detail=state.taskDetails[taskId];if(!detail)return;const pending={loading:true};detail.selectedAttemptId=attemptId;detail.attemptDiagnostics={...(detail.attemptDiagnostics||{}),[attemptId]:pending};render();try{const diagnostic=normalizedAttemptDiagnostic(await api(`/api/v1/attempts/${encodeURIComponent(attemptId)}/diagnostics?eventLimit=100&logLimit=200`));if(detail.attemptDiagnostics?.[attemptId]!==pending)return;detail.attemptDiagnostics[attemptId]=diagnostic}catch(error){if(detail.attemptDiagnostics?.[attemptId]!==pending)return;detail.attemptDiagnostics[attemptId]={error:error.message}}if(state.expandedTaskId===taskId)render()}
async function toggleAttemptDiagnostics(taskId,attemptId){const detail=state.taskDetails[taskId];if(!detail)return;if(detail.selectedAttemptId===attemptId){detail.selectedAttemptId=null;render();return}return loadTaskAttemptDiagnostics(taskId,attemptId)}
async function loadGlobalAttemptDiagnostics(attemptId){const pending={loading:true};state.selectedDiagnosticRunId=attemptId;state.diagnosticDetails[attemptId]=pending;render();try{const diagnostic=normalizedAttemptDiagnostic(await api(`/api/v1/attempts/${encodeURIComponent(attemptId)}/diagnostics?eventLimit=100&logLimit=200`));if(state.diagnosticDetails[attemptId]!==pending)return;state.diagnosticDetails[attemptId]=diagnostic}catch(error){if(state.diagnosticDetails[attemptId]!==pending)return;state.diagnosticDetails[attemptId]={error:error.message}}if(state.section==='diagnostics')render()}
async function toggleGlobalAttemptDiagnostics(attemptId){if(state.selectedDiagnosticRunId===attemptId){state.selectedDiagnosticRunId=null;render();return}return loadGlobalAttemptDiagnostics(attemptId)}
async function loadDiagnosticRuns(reset=false){if(state.diagnosticRunsLoading)return;state.diagnosticRunsLoading=true;state.diagnosticRunsError=null;if(reset){state.diagnosticRuns=[];state.diagnosticRunsCursor=null;state.selectedDiagnosticRunId=null}render();try{const cursor=reset?null:state.diagnosticRunsCursor,result=await api(`/api/v1/diagnostics/runs?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`),known=new Set(state.diagnosticRuns.map(item=>item.attemptId));state.diagnosticRuns.push(...(result.runs||[]).filter(item=>!known.has(item.attemptId)));state.diagnosticRunsCursor=result.nextCursor||null}catch(error){state.diagnosticRunsError=error.message}finally{state.diagnosticRunsLoading=false;if(state.section==='diagnostics')render()}}
async function loadMoreAttempts(taskId){const detail=state.taskDetails[taskId],cursor=detail?.nextAttemptCursor;if(!cursor||detail.loadingMoreAttempts)return;detail.loadingMoreAttempts=true;render();try{const result=await api(`/api/v1/tasks/${encodeURIComponent(taskId)}/attempts?limit=20&timing=engine&cursor=${encodeURIComponent(cursor)}`),known=new Set(detail.attempts.map(item=>item.id));detail.attempts.push(...(result.attempts||[]).filter(item=>!known.has(item.id)));detail.nextAttemptCursor=result.nextCursor||null}catch(error){toast(`Older runs could not be loaded: ${error.message}`,true)}finally{detail.loadingMoreAttempts=false;if(state.expandedTaskId===taskId)render()}}
const taskDetailRefreshes=new Set();
async function refreshTaskDetails(taskId,quiet=false){
  const task=state.tasks.find(item=>item.id===taskId),attemptId=task?.latestAttempt?.id,previous=state.taskDetails[taskId],authorization=state.token,session=state.adminSession;
  let generation=projectDataGeneration;
  const current=()=>state.token===authorization&&state.adminSession===session&&projectDataGeneration===generation&&state.tasks.some(item=>item.id===taskId);
  const options=quiet?{recoveryGuard:current}:undefined;
  if(!task||taskDetailRefreshes.has(taskId))return;
  taskDetailRefreshes.add(taskId);
  try{
    const requests=[api(`/api/v1/tasks/${encodeURIComponent(taskId)}`,options),api(`/api/v1/tasks/${encodeURIComponent(taskId)}/storage?limit=100`,options),api(`/api/v1/datasets/${encodeURIComponent(task.datasetId)}/gcp-sets`,options),api(`/api/v1/tasks/${encodeURIComponent(taskId)}/attempts?limit=20&timing=engine`,options)];
    if(attemptId)requests.push(api(`/api/v1/attempts/${encodeURIComponent(attemptId)}?logLimit=100`,options));
    const results=await Promise.allSettled(requests);
    if(!current())return;
    const returnedTask=results[0].value?.task;
    const refreshedTask=returnedTask&&((returnedTask.folderRevision??0)>=(task.folderRevision??0))?returnedTask:task,freshAttemptId=refreshedTask.latestAttempt?.id;
    let attemptResult=attemptId&&freshAttemptId===attemptId?results[4]?.value:null,logsError=Boolean(attemptId&&results[4]?.status==='rejected');
    if(freshAttemptId&&freshAttemptId!==attemptId){
      try{attemptResult=await api(`/api/v1/attempts/${encodeURIComponent(freshAttemptId)}?logLimit=100`,options);logsError=false}catch{logsError=true}
      if(!current())return;
    }
    const attemptPage=results[3].value||{},freshAttempts=attemptPage.attempts||previous?.attempts||[],attempts=quiet&&previous?.attempts?.length>freshAttempts.length?[...freshAttempts,...previous.attempts.filter(item=>!freshAttempts.some(fresh=>fresh.id===item.id))]:freshAttempts,sameAttempt=previous?.attempt?.id===freshAttemptId;
    if(JSON.stringify(task)!==JSON.stringify(refreshedTask))generation=++projectDataGeneration;
    state.tasks=state.tasks.map(item=>item.id===taskId?refreshedTask:item);
    state.taskDetails[taskId]={task:refreshedTask,storage:results[1].value||previous?.storage||null,gcp:quiet&&previous?.gcp?previous.gcp:(results[2].value||{sets:[]}),attempts,nextAttemptCursor:quiet&&previous?.attempts?.length>freshAttempts.length?previous.nextAttemptCursor:(attemptPage.nextCursor||null),attemptDiagnostics:previous?.attemptDiagnostics||{},selectedAttemptId:previous?.selectedAttemptId||null,attempt:attemptResult?.attempt||refreshedTask.latestAttempt,logs:(attemptResult?.logs||(sameAttempt?previous?.logs:[])||[]).slice(-100),logsError};
    if(refreshedTask.folderId!==task.folderId&&Array.isArray(folderCache.get(task.projectId)?.folders)&&
        state.selectedProjectId===task.projectId)syncSelectedTaskFolder(task.projectId);
    if(!quiet){try{await refreshGcpWorkspace(taskId,false)}catch(error){state.taskDetails[taskId].gcp={...(state.taskDetails[taskId].gcp||{sets:[]}),error:error.message}}}
    if(!current())return;
    if(state.expandedTaskId===taskId){
      const panel=quiet?content.querySelector(`[data-task-output="${CSS.escape(taskId)}"]`):null;
      if(panel)patchTaskOutput(panel,refreshedTask,state.taskDetails[taskId].attempt,state.taskDetails[taskId].logs);
      if(quiet){projectPaintPending=patchProjectTree(refreshedTask.projectId);}
      else{render();document.querySelector(`[data-action="toggle-task"][data-id="${CSS.escape(taskId)}"]`)?.focus()}
    }
  }finally{taskDetailRefreshes.delete(taskId)}
}

function releaseGcpImage(workspace){if(workspace?.imageUrl){URL.revokeObjectURL(workspace.imageUrl);workspace.imageUrl=null}if(workspace){workspace.activeImage=null;workspace.imageLoading=false;workspace.draftPixel=null;workspace.editingId=null}}
function releaseAllGcpImages(){Object.values(state.gcpWorkspaces).forEach(releaseGcpImage)}
async function refreshGcpWorkspace(taskId,shouldRender=true){const task=state.tasks.find(item=>item.id===taskId),detail=state.taskDetails[taskId],workspace=gcpWorkspace(taskId);if(!task||!detail)return;let sets=detail.gcp?.sets||[];if(!sets.some(set=>set.id===workspace.setId)){workspace.setId=sets[0]?.id||null;workspace.pointId=null;releaseGcpImage(workspace)}let points=[];if(workspace.setId){const setPayload=await api(`/api/v1/gcp-sets/${encodeURIComponent(workspace.setId)}`);points=setPayload.points||[];workspace.pointCache[workspace.setId]=points;sets=sets.map(set=>set.id===workspace.setId?{...set,...setPayload.set}:set);if(!points.some(point=>point.id===workspace.pointId)){workspace.pointId=points[0]?.id||null;releaseGcpImage(workspace)}}const correspondences=(await api(`/api/v1/tasks/${encodeURIComponent(taskId)}/gcp-correspondences`)).correspondences||[];let candidates=[],ranking=null;if(workspace.pointId){const query=new URLSearchParams({pointId:workspace.pointId,mode:workspace.mode,limit:'24'});if(workspace.mode==='radius')query.set('radiusM',String(workspace.radiusM));const response=await api(`/api/v1/datasets/${encodeURIComponent(task.datasetId)}/gcp-images?${query}`);candidates=response.images||[];ranking=response.ranking||null}detail.gcp={sets,points,correspondences,candidates,ranking,error:null};if(shouldRender&&state.expandedTaskId===taskId)render()}
async function changeGcpSet(taskId,setId){const workspace=gcpWorkspace(taskId);workspace.setId=setId;workspace.pointId=null;releaseGcpImage(workspace);try{await refreshGcpWorkspace(taskId)}catch(error){toast(error.message,true)}}
async function changeGcpPoint(taskId,pointId){const workspace=gcpWorkspace(taskId);workspace.pointId=pointId;releaseGcpImage(workspace);try{await refreshGcpWorkspace(taskId)}catch(error){toast(error.message,true)}}
async function refreshGcpCandidates(event){event.preventDefault();const form=event.currentTarget,workspace=gcpWorkspace(form.dataset.taskId);workspace.mode=form.elements.mode.value;if(workspace.mode==='radius')workspace.radiusM=Number(form.elements.radiusM.value);try{await refreshGcpWorkspace(form.dataset.taskId)}catch(error){toast(error.message,true)}}
async function privateGcpImage(datasetId,fileId){const response=await workspaceFetch(`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-images/${encodeURIComponent(fileId)}/content`,{headers:{Authorization:`Bearer ${state.token}`,Accept:'image/*'},cache:'no-store'});if(response.status===401){clearWorkspaceAuthorization();throw responseError('authorization_required',401)}if(response.status===403)throw responseError('Your current Viewer grant does not permit private source-image access',403);if(!response.ok){let payload;try{payload=await response.json()}catch{}throw responseError(payload?.message||payload?.error||`Image request failed (${response.status})`,response.status)}const type=response.headers.get('content-type')||'';if(!type.toLocaleLowerCase('en-US').startsWith('image/'))throw Error('The selected file is not a supported source image');return URL.createObjectURL(await response.blob())}
async function openGcpImage(taskId,imageFileId,editingId=null){const task=state.tasks.find(item=>item.id===taskId),detail=state.taskDetails[taskId],workspace=gcpWorkspace(taskId);if(!task||!detail||!workspace.pointId)return;const image=detail.gcp?.candidates?.find(candidate=>candidate.id===imageFileId)||{id:imageFileId,relativePath:imageFileId,width:null,height:null},mark=detail.gcp?.correspondences?.find(item=>item.id===editingId)||detail.gcp?.correspondences?.find(item=>item.pointId===workspace.pointId&&item.imageFileId===imageFileId);releaseGcpImage(workspace);workspace.activeImage={...image};workspace.imageLoading=true;workspace.editingId=mark?.id||null;workspace.draftPixel=mark?{pixelX:mark.pixelX,pixelY:mark.pixelY}:null;render();try{workspace.imageUrl=await privateGcpImage(task.datasetId,imageFileId);workspace.imageLoading=false;render();queueMicrotask(()=>content.querySelector('.gcp-mark-image')?.focus())}catch(error){workspace.imageLoading=false;workspace.activeImage=null;if(error.status!==401){toast(error.message,true);render()}}}
function configureGcpImage(image){const workspace=gcpWorkspace(image.dataset.taskId);if(!workspace.activeImage)return;workspace.activeImage.width=image.naturalWidth;workspace.activeImage.height=image.naturalHeight;image.tabIndex=0;image.setAttribute('role','button');image.setAttribute('aria-label',`${image.alt}. Click to set the control point pixel.`);const form=content.querySelector(`.gcp-mark-form[data-task-id="${CSS.escape(image.dataset.taskId)}"]`);if(form){form.elements.pixelX.max=String(Math.max(0,image.naturalWidth-0.001));form.elements.pixelY.max=String(Math.max(0,image.naturalHeight-0.001))}positionGcpMarker(image.dataset.taskId)}
function positionGcpMarker(taskId){const workspace=gcpWorkspace(taskId),marker=content.querySelector(`.gcp-mark-image[data-task-id="${CSS.escape(taskId)}"]`)?.parentElement.querySelector('.gcp-marker');if(!marker)return;const style=gcpMarkerStyle(workspace);marker.hidden=!style;if(style)marker.style.cssText=style}
function setGcpDraft(taskId,pixelX,pixelY){const workspace=gcpWorkspace(taskId);workspace.draftPixel=Number.isFinite(pixelX)&&Number.isFinite(pixelY)?{pixelX,pixelY}:null;positionGcpMarker(taskId)}
function markGcpImage(event){if(!can('viewer.gcp.write'))return;const image=event.currentTarget,rect=image.getBoundingClientRect();if(!rect.width||!rect.height||!image.naturalWidth||!image.naturalHeight)return;const pixelX=Math.max(0,Math.min(image.naturalWidth-0.001,(event.clientX-rect.left)*image.naturalWidth/rect.width)),pixelY=Math.max(0,Math.min(image.naturalHeight-0.001,(event.clientY-rect.top)*image.naturalHeight/rect.height)),form=content.querySelector(`.gcp-mark-form[data-task-id="${CSS.escape(image.dataset.taskId)}"]`);if(!form)return;form.elements.pixelX.value=pixelX.toFixed(2);form.elements.pixelY.value=pixelY.toFixed(2);setGcpDraft(image.dataset.taskId,pixelX,pixelY)}
async function saveGcpMark(event){event.preventDefault();const form=event.currentTarget,taskId=form.dataset.taskId,workspace=gcpWorkspace(taskId),pixelX=Number(form.elements.pixelX.value),pixelY=Number(form.elements.pixelY.value),imageFileId=form.elements.imageFileId.value,existing=state.taskDetails[taskId]?.gcp?.correspondences?.find(item=>item.id===workspace.editingId)||state.taskDetails[taskId]?.gcp?.correspondences?.find(item=>item.pointId===workspace.pointId&&item.imageFileId===imageFileId);if(!workspace.pointId||!Number.isFinite(pixelX)||!Number.isFinite(pixelY))return toast('Select a control point and valid image coordinates',true);if(state.busy)return;state.busy=true;try{const result=await navigationWork.trackGcpSave(()=>existing?api(`/api/v1/gcp-correspondences/${encodeURIComponent(existing.id)}`,{method:'PATCH',body:{pixelX,pixelY}}):api(`/api/v1/tasks/${encodeURIComponent(taskId)}/gcp-correspondences`,{method:'POST',body:{pointId:workspace.pointId,imageFileId,pixelX,pixelY}}));workspace.editingId=result.correspondence.id;workspace.draftPixel={pixelX:result.correspondence.pixelX,pixelY:result.correspondence.pixelY};const acknowledgedMarks=state.taskDetails[taskId]?.gcp?.correspondences;if(Array.isArray(acknowledgedMarks)){const index=acknowledgedMarks.findIndex(mark=>mark.id===result.correspondence.id);if(index<0)acknowledgedMarks.push(result.correspondence);else acknowledgedMarks[index]=result.correspondence;}toast(existing?'GCP image mark updated':'GCP image mark saved');await refreshGcpWorkspace(taskId)}catch(error){toast(error.message,true)}finally{state.busy=false}}
async function editGcpMark(taskId,id){const detail=state.taskDetails[taskId],workspace=gcpWorkspace(taskId),mark=detail?.gcp?.correspondences?.find(item=>item.id===id);if(!mark)return;let located=null;for(const set of detail.gcp.sets||[]){let points=workspace.pointCache[set.id];if(!points){try{points=(await api(`/api/v1/gcp-sets/${encodeURIComponent(set.id)}`)).points||[];workspace.pointCache[set.id]=points}catch{continue}}if(points.some(point=>point.id===mark.pointId)){located=set.id;break}}if(!located)return toast('The marked control point is no longer available',true);workspace.setId=located;workspace.pointId=mark.pointId;try{await refreshGcpWorkspace(taskId,false);await openGcpImage(taskId,mark.imageFileId,id)}catch(error){toast(error.message,true)}}
async function deleteGcpMark(taskId,id){if(!await dialogs.confirm('Delete this saved image correspondence?',{title:'Delete image mark',submitLabel:'Delete mark',destructive:true}))return;if(state.busy)return;state.busy=true;try{await api(`/api/v1/gcp-correspondences/${encodeURIComponent(id)}`,{method:'DELETE'});const workspace=gcpWorkspace(taskId);if(workspace.editingId===id){workspace.editingId=null;workspace.draftPixel=null}toast('GCP image mark deleted');await refreshGcpWorkspace(taskId)}catch(error){toast(error.message,true)}finally{state.busy=false}}
function newProjectModal(){openModal('Create project',`<form id="project-form" class="manage-form">${field('Project name','displayName','required maxlength="240"')}${field('Description','description','maxlength="1000"')}<button class="primary-button">Create project</button></form>`);modalContent.querySelector('#project-form').onsubmit=event=>{event.preventDefault();modal.close();mutate('/api/v1/projects',{method:'POST',body:values(event.currentTarget)},'Project created')}}
// Property lines source: raw file bytes for the upload, JSON otherwise; the same Bearer session and Idempotency-Key rule as api().
async function propertyLinesRequest(path,{method='GET',body,raw}={}){const headers={Authorization:`Bearer ${state.token}`,Accept:'application/json'};if(method!=='GET')headers['Idempotency-Key']=crypto.randomUUID();let payload;if(raw!==undefined){headers['Content-Type']='application/octet-stream';payload=raw}else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body)}const response=await workspaceFetch(path,{method,headers,body:payload});let json=null;try{json=await response.json()}catch{}if(response.status===401){clearWorkspaceAuthorization();throw responseError('authorization_required',401)}if(response.status===403)throw responseError('Your current Viewer grant does not permit this action',403);if(!response.ok)throw responseError(json?.message||json?.error||`Request failed (${response.status})`,response.status);return json}
function propertyLinesSourceModal(id){const project=state.projects.find(item=>item.id===id);if(!project)return;openModal('Property lines source','<div data-property-lines-source></div>');mountPropertyLinesSource({container:modalContent.querySelector('[data-property-lines-source]'),projectId:project.id,request:propertyLinesRequest,toast,confirm:message=>dialogs.confirm(message,{title:'Remove boundary file',submitLabel:'Remove',destructive:true}),canWrite:can('viewer.projects.write')&&project.status==='active'})}
function editProject(id){const project=state.projects.find(item=>item.id===id);if(!project)return;openModal('Rename project',`<form id="project-edit-form" class="manage-form">${field('Project name','displayName',`required maxlength="240" value="${esc(project.displayName)}"`)}${field('Description','description',`maxlength="1000" value="${esc(project.description||'')}"`)}<button class="primary-button">Save project</button></form>`);modalContent.querySelector('#project-edit-form').onsubmit=event=>{event.preventDefault();modal.close();mutate(`/api/v1/projects/${encodeURIComponent(id)}`,{method:'PATCH',body:values(event.currentTarget)},'Project updated')}}
// ---- Tree focus: one tab stop, roving over each row's focus target ----
function treeRowElement(key){return key?content.querySelector(`#project-list [data-tree-key="${CSS.escape(key)}"]`):null}
function treeFocusTarget(key){return treeRowElement(key)?.querySelector('[data-tree-focus]')||null}
function treeFocusKey(){const element=document.activeElement;return element?.matches?.('[data-tree-focus]')&&content.contains(element)?element.closest('[data-tree-key]')?.dataset.treeKey||null:null}
function syncTreeTabStop(){
  const list=content.querySelector('#project-list');if(!list)return;
  const targets=[...list.querySelectorAll('[data-tree-focus]')];if(!targets.length)return;
  const current=targets.find(target=>target.closest('[data-tree-key]')?.dataset.treeKey===treeCurrentKey)||targets[0];
  treeCurrentKey=current.closest('[data-tree-key]').dataset.treeKey;
  for(const target of targets){const index=target===current?0:-1;if(target.tabIndex!==index)target.tabIndex=index;}
}
// After a full render, focus returns to the same row when the render took it away.
function restoreTreeFocus(key){const active=document.activeElement;if(!key||(active&&active!==document.body&&active.isConnected))return;treeFocusTarget(key)?.focus({preventScroll:true})}
function focusTreeRow(key,{scroll=true}={}){
  const target=treeFocusTarget(key);if(!target)return false;
  treeCurrentKey=key;syncTreeTabStop();target.focus({preventScroll:true});
  if(scroll)target.scrollIntoView({block:'nearest'});
  return true;
}
function announce(message){const live=document.querySelector('#workspace-tree-live');if(!live)return;live.textContent='';setTimeout(()=>{live.textContent=message},30)}
function flashTreeRow(key){const row=treeRowElement(key);if(!row||reducedMotion())return;row.classList.remove('tree-just-moved');void row.offsetWidth;row.classList.add('tree-just-moved');setTimeout(()=>row.classList.remove('tree-just-moved'),1900)}
// The next row at the same level, else the previous one, else the parent: where focus goes when a row leaves.
function treeNeighbourKey(key){
  const row=treeRowElement(key);if(!row)return null;
  const parent=row.dataset.treeParent||null,siblings=parent?[...row.parentElement.querySelectorAll(':scope > [data-tree-parent]')].filter(item=>item.dataset.treeParent===parent&&item.querySelector('[data-tree-focus]')):[];
  const index=siblings.indexOf(row);
  return(siblings[index+1]||siblings[index-1])?.dataset.treeKey||parent;
}
function treeLocationLabel(projectId,folderId){
  const project=state.projects.find(item=>item.id===projectId)?.displayName||'the project',folders=folderCache.get(projectId)?.folders||[];
  const path=folderId?folderPath(folders,folderId).map(folder=>folder.displayName):[];
  return path.length?`${project} / ${path.join(' / ')}`:`${project} (top level)`;
}
function closeTreeMenus(except=null){content.querySelectorAll('details.tree-menu[open]').forEach(menu=>{if(menu!==except)menu.open=false;});}

// ---- Projects and folders: open, close, create, rename, delete ----
function toggleTreeProject(projectId,open=!isProjectOpen(projectId)){
  if(!state.projects.some(project=>project.id===projectId))return;
  treeCurrentKey=`p:${projectId}`;
  if(open){
    touchOpenProject(projectId);saveTreeState();
    // An open task keeps the URL; otherwise the project just opened becomes the selected one.
    if(state.expandedTaskId&&state.selectedProjectId&&state.selectedProjectId!==projectId)return render();
    return navigateWorkspace({section:'dashboard',selectedProjectId:projectId,expandedTaskId:null},'push');
  }
  treeState.projects.delete(projectId);saveTreeState();
  if(state.selectedProjectId===projectId)return navigateWorkspace({section:'dashboard',selectedProjectId:null,expandedTaskId:null},'push');
  render();
}
function toggleTreeFolder(projectId,folderId){
  const folders=folderCache.get(projectId)?.folders;
  if(!folders?.some(folder=>folder.id===folderId))return;
  treeCurrentKey=`f:${folderId}`;
  if(treeState.folders.has(folderId)){
    const task=state.tasks.find(item=>item.id===state.expandedTaskId&&item.projectId===projectId);
    if(task&&folderAncestry(folders,task.folderId).includes(folderId)){
      // Closing the folder that holds the open task closes the task too, unless it has unsaved work.
      if(taskEditActive(state.taskPage?content:treeRowElement(`t:${task.id}`)))return toast('Finish or close the open task first.',true);
      treeState.folders.delete(folderId);saveTreeState();
      state.expandedTaskId=null;state.taskPage=null;syncWorkspaceView('replace');return render();
    }
    treeState.folders.delete(folderId);
  }else treeState.folders.add(folderId);
  saveTreeState();
  projectPaintPending=patchProjectTree(projectId)||projectPaintPending;
}
// The toolbar's New folder goes into the focused project or folder (a task's own folder).
function treeNewFolderTarget(){
  const row=treeRowElement(treeCurrentKey),projectId=row?.dataset.treeProject||openProjectIds()[0];
  const project=state.projects.find(item=>item.id===projectId);
  if(!isProjectOpen(projectId)||!canWriteFolders(project))return null;
  const key=row?.dataset.treeProject===projectId?row.dataset.treeKey:'',folders=folderCache.get(projectId)?.folders||[];
  if(key.startsWith('f:'))return{projectId,parentId:key.slice(2)};
  if(key.startsWith('t:')){const folderId=state.tasks.find(item=>item.id===key.slice(2))?.folderId;return{projectId,parentId:folders.some(folder=>folder.id===folderId)?folderId:null};}
  return{projectId,parentId:null};
}
function focusInlineName(projectId){const input=content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"] .tree-inline-name`);if(!input)return;input.focus();input.select();input.scrollIntoView({block:'nearest'})}
function startNewFolder(projectId,parentId=null){
  const project=state.projects.find(item=>item.id===projectId),folders=folderCache.get(projectId)?.folders;
  if(!canWriteFolders(project)||state.busy)return;
  if(!folders)return toast('Folders are still loading.',true);
  if(parentId&&!folders.some(folder=>folder.id===parentId))return;
  treeRenaming=null;treePending={projectId,parentId};
  touchOpenProject(projectId);if(parentId)folderAncestry(folders,parentId).forEach(id=>treeState.folders.add(id));saveTreeState();
  if(content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"]`))patchProjectTree(projectId);else render();
  focusInlineName(projectId);
}
function startFolderRename(projectId,folderId){
  const project=state.projects.find(item=>item.id===projectId);
  if(!canWriteFolders(project)||state.busy||!folderCache.get(projectId)?.folders?.some(folder=>folder.id===folderId))return;
  treePending=null;treeRenaming=`f:${folderId}`;
  patchProjectTree(projectId);focusInlineName(projectId);
}
// Puts one row back from fresh markup (an inline name ends), or removes it when it no longer exists.
function replaceTreeRow(projectId,key){
  const row=treeRowElement(key),project=state.projects.find(item=>item.id===projectId);if(!row||!project)return;
  const template=document.createElement('template');template.innerHTML=projectTree(project);
  const fresh=template.content.querySelector(`[data-tree-key="${CSS.escape(key)}"]`);
  if(fresh)row.replaceWith(fresh);else row.remove();
  bindProjectActions(content.querySelector(`[data-tree-body="${CSS.escape(projectId)}"]`)||content);
}
// Waits (up to 10 s) for another change to finish, so a typed name is never dropped.
async function treeWhenIdle(limit=10_000){
  for(const end=performance.now()+limit;state.busy&&performance.now()<end;)await new Promise(resolve=>setTimeout(resolve,100));
  return!state.busy;
}
async function commitTreeName(input,cancel=false){
  if(input.dataset.committing)return;input.dataset.committing='1';
  const projectId=input.dataset.projectId,value=input.value.trim(),row=input.closest('[data-tree-key]'),key=row?.dataset.treeKey;
  // Saving on blur must not pull focus back from wherever the user went (the search box, say):
  // the row takes focus only when the name field had it, or nothing does once the field is gone.
  const start=document.activeElement,ownedFocus=start===input||!start||start===document.body||!start.isConnected;
  const refocus=(target,options)=>{
    if(!ownedFocus)return false;
    const active=document.activeElement;
    return(!active||active===document.body||!active.isConnected||active===input)&&focusTreeRow(target,options);
  };
  const idle=async()=>{if(await treeWhenIdle())return true;toast(`“${value}” was not saved because another change is still running. Try again.`,true);return false;};
  if(input.hasAttribute('data-tree-new-folder')){
    const parentId=input.dataset.treeNewFolder||null,parentKey=parentId?`f:${parentId}`:`p:${projectId}`;
    treePending=null;
    if(cancel||!value){replaceTreeRow(projectId,key);refocus(parentKey,{scroll:false});return;}
    input.disabled=true;
    const ready=await idle();
    const authorized=folderAuthorizationGuard(projectId,'viewer.projects.write');
    const result=ready?await mutateFolder(projectId,`/api/v1/projects/${encodeURIComponent(projectId)}/folders`,folderRequestOptions('POST',{displayName:value,parentId},{}),null,authorized):null;
    if(treeRowElement(key))replaceTreeRow(projectId,key);
    const created=result?.folder?.id?`f:${result.folder.id}`:null;
    if(created){refocus(created);flashTreeRow(created);announce(`Created folder ${value} in ${treeLocationLabel(projectId,parentId)}.`);}
    else refocus(parentKey,{scroll:false});
    return;
  }
  const folderId=input.dataset.treeRename,folder=folderCache.get(projectId)?.folders?.find(item=>item.id===folderId);
  treeRenaming=null;
  if(cancel||!value||!folder||value===folder.displayName){replaceTreeRow(projectId,key);refocus(key,{scroll:false});return;}
  input.disabled=true;
  const ready=await idle();
  const authorized=folderAuthorizationGuard(projectId,'viewer.projects.write');
  const result=ready?await mutateFolder(projectId,`/api/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,folderRequestOptions('PATCH',{displayName:value},{}),null,authorized):null;
  replaceTreeRow(projectId,key);refocus(key,{scroll:false});
  if(result)announce(`Renamed folder to ${value}.`);
}
// Only empty folders can be deleted; Undo creates the same empty folder again in the same place.
async function deleteFolder(projectId,folderId){
  const project=state.projects.find(item=>item.id===projectId),entry=folderCache.get(projectId),folder=entry?.folders?.find(item=>item.id===folderId);
  if(!folder||!canWriteFolders(project)||state.busy)return;
  if(!folderIsEmpty(entry.folders,state.tasks.filter(task=>task.projectId===projectId),folderId))return toast('Only empty folders can be deleted.',true);
  const authorized=folderAuthorizationGuard(projectId,'viewer.projects.write'),key=`f:${folderId}`,neighbour=treeNeighbourKey(key);
  const result=await mutateFolder(projectId,`/api/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,folderRequestOptions('DELETE',undefined,{}),null,authorized,null,false);
  if(!result)return;
  const hadFocus=Boolean(treeRowElement(key)?.contains(document.activeElement));
  if(folderCache.get(projectId)===entry&&entry.folders)entry.folders=entry.folders.filter(item=>item.id!==folderId);
  treeState.folders.delete(folderId);saveTreeState();
  projectPaintPending=patchProjectTree(projectId,{releasedKey:key})||projectPaintPending;
  if(hadFocus&&!(neighbour&&focusTreeRow(neighbour,{scroll:false})))focusTreeRow(`p:${projectId}`,{scroll:false});
  announce(`Deleted folder ${folder.displayName}.`);
  void loadProjectFolders(projectId);
  offerUndo('Folder deleted',10_000,()=>canWriteFolders(state.projects.find(item=>item.id===projectId))&&isProjectOpen(projectId),async()=>{
    const undoFocus=captureUndoFocus();
    const restored=await mutateFolder(projectId,`/api/v1/projects/${encodeURIComponent(projectId)}/folders`,folderRequestOptions('POST',{displayName:folder.displayName,parentId:folder.parentId||null},{}),'Folder restored',folderAuthorizationGuard(projectId,'viewer.projects.write'));
    if(restored?.folder?.id){const restoredKey=`f:${restored.folder.id}`;settleUndoFocus(undoFocus,restoredKey);flashTreeRow(restoredKey);announce(`Restored folder ${folder.displayName}.`);}
  });
}

// ---- Moving tasks ----
function canDragFolderTask(task){
  return task.status!=='archived'&&Array.isArray(folderCache.get(task.projectId)?.folders)&&
    Number.isSafeInteger(task.folderRevision)&&state.projects.some(project=>project.id===task.projectId&&project.status==='active')&&
    folderAuthorizationGuard(task.projectId,'viewer.processing.write',{open:false})();
}
// A move shows where the task went: its destination project and folders open.
function revealTaskDestination(projectId,folderId){
  touchOpenProject(projectId);
  const folders=folderCache.get(projectId)?.folders;
  if(folderId&&folders)folderAncestry(folders,folderId).forEach(id=>treeState.folders.add(id));
  else if(folderId)treeReveals.set(projectId,folderId);
  saveTreeState();
}

// Read when the move lands, before any repaint: does the move own focus (the moved row or
// the move dialog), does nothing hold it, or has the user moved on to another control?
function captureTaskMoveFocus(taskId){
  const key=`t:${taskId}`,row=treeRowElement(key);
  const neighbourKey=row?treeNeighbourKey(key):null,element=document.activeElement;
  if(!element||element===document.body||!element.isConnected)return{mode:'none'};
  if(row?.contains(element)||modal.open&&modal.contains(element))return{mode:'moved',neighbourKey};
  let selection=null;
  try{if(typeof element.selectionStart==='number')selection=[element.selectionStart,element.selectionEnd];}catch{}
  return{mode:'other',element,locate:focusLocator(element),selection};
}
// How to find exactly this control again after a full render, or null when it cannot be
// named uniquely; a generic or ambiguous match never receives focus.
function focusLocator(element){
  const unique=(scope,selector)=>{const matches=scope?.querySelectorAll(selector)||[];return matches.length===1?matches[0]:null;};
  const disclosure=element.localName==='summary'&&element.parentElement?.matches('details[data-task-disclosure][data-task-id]')?element.parentElement:null;
  if(disclosure){
    const selector=`details[data-task-id="${CSS.escape(disclosure.dataset.taskId)}"][data-task-disclosure="${CSS.escape(disclosure.dataset.taskDisclosure)}"]`;
    return unique(content,selector)===disclosure?()=>unique(content,selector)?.querySelector(':scope > summary')||null:null;
  }
  const attributes=['id','data-action','data-id','name','aria-label','data-folder-drag'].filter(name=>element.hasAttribute(name));
  if(!attributes.some(name=>name!=='data-folder-drag'))return null;
  const selector=element.localName+attributes.map(name=>`[${name}="${CSS.escape(element.getAttribute(name))}"]`).join('');
  const rowId=element.closest('[data-project-task]')?.dataset.projectTask||null;
  const find=()=>unique(rowId?content.querySelector(`[data-project-task="${CSS.escape(rowId)}"]`):document,selector);
  return find()===element?find:null;
}
// A move moves focus only when it took focus away; a control the user chose keeps it.
function settleTaskMoveFocus(taskId,focus){
  if(focus.mode==='moved')return placeTaskMoveFocus(taskId,{neighbourKey:focus.neighbourKey});
  if(focus.mode!=='other')return;
  const target=focus.element.isConnected?focus.element:focus.locate?.();
  if(!target||document.activeElement===target)return;
  target.focus({preventScroll:true});
  if(focus.selection)try{target.setSelectionRange(...focus.selection);}catch{}
}
// Focus follows the moved row to its new place; failing that, its old neighbour, then the tree.
function placeTaskMoveFocus(taskId,{neighbourKey=null}={}){
  const active=document.activeElement;
  if(active&&active!==document.body&&active.isConnected)return;
  if(focusTreeRow(`t:${taskId}`)||neighbourKey&&focusTreeRow(neighbourKey,{scroll:false}))return;
  const list=content.querySelector('#project-list');
  if(!list)return;
  list.tabIndex=-1;
  list.focus({preventScroll:true});
}

function clearFolderUndo(){
  clearTimeout(folderUndoTimer);
  folderUndo=null;
  document.querySelector('#workspace-folder-undo')?.replaceChildren();
}
// One Undo at a time, for remaining ms; the click re-checks the window and that Undo still applies.
function offerUndo(message,remaining,available,perform){
  clearFolderUndo();
  const target=document.querySelector('#workspace-folder-undo');
  if(!target||!Number.isFinite(remaining)||remaining<=0)return;
  const undo={deadline:performance.now()+remaining};
  const control=document.createElement('button');
  control.type='button';control.className='toast-action';control.textContent='Undo';
  control.onclick=()=>{
    if(folderUndo!==undo||performance.now()>=undo.deadline||!available()){clearFolderUndo();return;}
    if(state.busy)return;
    clearFolderUndo();
    void perform();
  };
  target.replaceChildren(document.createTextNode(message),control);
  folderUndo=undo;
  folderUndoTimer=setTimeout(clearFolderUndo,remaining);
}
// Moves follow the server's Undo window (10 s at most), measured on the server clock.
function offerMoveUndo(message,undoExpiresAt,serverTime,available,perform){
  return offerUndo(message,Math.min(10_000,Date.parse(undoExpiresAt)-Date.parse(serverTime)),available,perform);
}
function offerFolderUndo(task,previousFolderId,undoExpiresAt,serverTime,message='Task moved'){
  offerMoveUndo(message,undoExpiresAt,serverTime,()=>canDragFolderTask(task),()=>moveFolderTask(task,previousFolderId,{}, {undo:true}));
}
async function moveFolderTask(task,folderId,receipt,{undo=false,originActive=()=>true,onSuccess}={}){
  if(!canDragFolderTask(task)||folderId===task.folderId)return;
  const authorized=folderAuthorizationGuard(task.projectId,'viewer.processing.write',{open:false});
  const current=()=>authorized()&&originActive()&&state.tasks.some(value=>value.id===task.id&&value.projectId===task.projectId&&value.status!=='archived');
  const body={folderId,expectedFolderId:task.folderId??null,expectedFolderRevision:task.folderRevision,...(undo?{undo:true}:{})};
  const result=await mutateFolder(task.projectId,`/api/v1/tasks/${encodeURIComponent(task.id)}/folder`,folderRequestOptions('PATCH',body,receipt),
    undo?'Task moved back':null,current,({task:updated,undoExpiresAt,serverTime}={})=>{
      if(updated?.id!==task.id||updated.projectId!==task.projectId||updated.folderId!==folderId||updated.folderRevision!==task.folderRevision+1){
        throw Error('Task move could not be confirmed. Check the current folder.');
      }
      projectDataGeneration++;
      const focus=captureTaskMoveFocus(task.id);
      state.tasks=state.tasks.map(value=>value.id===updated.id?{...value,...updated}:value);
      revealTaskDestination(task.projectId,folderId);
      syncSelectedTaskFolder(task.projectId);
      projectPaintPending=patchProjectTree(task.projectId,{movedTaskId:task.id})||projectPaintPending;
      onSuccess?.();
      settleTaskMoveFocus(task.id,focus);
      flashTreeRow(`t:${task.id}`);
      const where=treeLocationLabel(task.projectId,folderId);
      announce(`${undo?'Moved back':'Moved'} ${task.displayName||'the task'} to ${where}.`);
      if(!undo)offerFolderUndo(updated,body.expectedFolderId,undoExpiresAt,serverTime,`Task moved to ${where}`);
    },false);
  // Conflicts and lost responses also require a fresh server read.
  scheduleProjectRefresh(0);
  return result;
}

// ---- Drag and drop (desktop pointer): the whole task row or its grip ----
function clearTaskDrag(){
  draggedFolderTask=null;clearTimeout(treeDragExpandTimer);treeDragExpandTimer=null;treeDragHover=null;
  document.body.classList.remove('tree-dragging');
  content.querySelectorAll('.folder-drop-active').forEach(element=>element.classList.remove('folder-drop-active'));
  content.querySelectorAll('.tree-drag-source').forEach(element=>element.classList.remove('tree-drag-source'));
}
function beginTaskDrag(event){
  const handle=event.target.closest?.('[data-folder-drag]');
  if(!handle)return;
  if(event.target.closest('input,textarea,select,details[open]')){event.preventDefault();return;}
  const task=state.tasks.find(value=>value.id===handle.dataset.id);
  if(!task||!event.dataTransfer||!canDragFolderTask(task)||!treeDragAvailable()){event.preventDefault();return;}
  clearTaskDrag();closeTreeMenus();
  draggedFolderTask=task;
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('text/plain','Viewer task');
  const row=handle.closest('.task-panel');
  requestAnimationFrame(()=>{if(draggedFolderTask!==task)return;document.body.classList.add('tree-dragging');row?.classList.add('tree-drag-source');});
}
// A project row (top level), a folder row or an empty folder; never the task's current place.
function taskDropTarget(event){
  const task=draggedFolderTask,element=event.target.closest?.('[data-task-drop-project]');
  if(!task||!element||!content.contains(element)||!canDragFolderTask(task))return null;
  const projectId=element.dataset.taskDropProject,folderId=element.dataset.taskDropFolder||null;
  if(!state.projects.some(project=>project.id===projectId&&project.status==='active'))return null;
  if(folderId&&!folderCache.get(projectId)?.folders?.some(folder=>folder.id===folderId))return null;
  if(projectId===task.projectId)return(task.folderId||null)===folderId?null:{element,projectId,folderId};
  return canMoveTaskAcrossProjects()?{element,projectId,folderId}:null;
}
function setTreeDragHover(element){
  if(treeDragHover===element)return;
  treeDragHover?.classList.remove('folder-drop-active');clearTimeout(treeDragExpandTimer);treeDragExpandTimer=null;
  treeDragHover=element;
  if(!element)return;
  element.classList.add('folder-drop-active');
  // A closed folder or project opens after a short hover, so a drop can go deeper.
  if(element.getAttribute('aria-expanded')==='false')treeDragExpandTimer=setTimeout(()=>expandDuringDrag(element),700);
}
function expandDuringDrag(element){
  treeDragExpandTimer=null;
  if(!draggedFolderTask||!element.isConnected)return;
  const key=element.dataset.treeKey||'',projectId=element.dataset.treeProject,project=state.projects.find(item=>item.id===projectId);
  if(!project)return;
  if(key.startsWith('f:')){treeState.folders.add(key.slice(2));saveTreeState();projectPaintPending=patchProjectTree(projectId)||projectPaintPending;return;}
  const article=element.closest('.project-row');
  touchOpenProject(projectId);saveTreeState();
  if(!article||article.querySelector('[data-tree-body]'))return;
  article.classList.add('selected');
  article.insertAdjacentHTML('beforeend',projectTree(project));
  syncProjectHead(project);
  bindProjectActions(article);
}
async function dropTaskOnProject(task,projectId,folderId){
  let confirmSharingChange=false;
  if(taskHasPublishedOutput(task)){
    const from=state.projects.find(project=>project.id===task.projectId)?.displayName||'the current project',to=state.projects.find(project=>project.id===projectId)?.displayName||'the other project';
    if(!await dialogs.confirm(`This task is published. Moving it to ${to} removes it from the shares of ${from} and shows it to clients of ${to}.`,{title:'Move published task',submitLabel:'Move and change access'}))return;
    confirmSharingChange=true;
  }
  return moveProjectTask(task,projectId,folderId,{}, {confirmSharingChange});
}

function canMoveTaskAcrossProjects(){
  return can('viewer.processing.write')&&can('viewer.projects.write')&&can('viewer.datasets.write');
}
function taskHasPublishedOutput(task){
  return state.outputs.some(output=>output.taskId===task.id&&output.status==='published');
}
function folderPickerOptions(folders,selectedId){
  return`<option value="">Project root</option>${folders.map(folder=>`<option value="${esc(folder.id)}" ${folder.id===selectedId?'selected':''}>${esc(folderPath(folders,folder.id).map(item=>item.displayName).join(' / '))}</option>`).join('')}`;
}
function phoneLayout(){return typeof matchMedia==='function'&&matchMedia('(max-width:720px)').matches}
function moveTaskFolderModal(taskId,{projectId:initialProjectId=null}={}){
  const task=state.tasks.find(item=>item.id===taskId),folders=task&&folderCache.get(task.projectId)?.folders;
  if(!task||!folders||!canDragFolderTask(task))return;
  const authorized=folderAuthorizationGuard(task.projectId,'viewer.processing.write',{open:false});if(!authorized())return;
  const projects=canMoveTaskAcrossProjects()?state.projects.filter(project=>project.status==='active'):state.projects.filter(project=>project.id===task.projectId);
  const startProject=projects.some(project=>project.id===initialProjectId)?initialProjectId:task.projectId,published=taskHasPublishedOutput(task);
  const projectField=projects.length>1
    ?`<label><span>Project</span><select name="projectId">${projects.map(project=>`<option value="${esc(project.id)}" ${project.id===startProject?'selected':''}>${esc(project.displayName)}${project.id===task.projectId?' (current)':''}</option>`).join('')}</select></label>`
    :`<input type="hidden" name="projectId" value="${esc(task.projectId)}">`;
  openModal('Move task',`<form id="folder-move-form" class="manage-form task-move-form"><p>Choose where <strong>${esc(task.displayName)}</strong> should go.</p>${projectField}<label><span>Folder</span><select name="folderId">${folderPickerOptions(folders,task.folderId)}</select></label><p class="form-note" data-move-folder-status role="status" hidden></p><div class="task-move-project-note" data-move-project-note hidden><p class="form-note">Its source photos, processing history and outputs move with it.</p>${published?`<label class="task-move-confirm"><input type="checkbox" name="confirmSharingChange"><span>This task is published. Clients who see it through the current project's shares lose access, and clients of the new project gain it.</span></label>`:''}</div><button class="primary-button">Move task</button></form>`,phoneLayout()?'sheet-modal':'');
  const form=modalContent.querySelector('#folder-move-form'),receipt={},pickerFolders=new Map([[task.projectId,folders]]);
  const folderSelect=form.elements.folderId,submit=form.querySelector('button.primary-button'),status=form.querySelector('[data-move-folder-status]'),note=form.querySelector('[data-move-project-note]');
  let folderRequest=0;
  const current=()=>authorized()&&form.isConnected&&state.tasks.some(value=>value.id===taskId&&value.projectId===task.projectId&&value.status!=='archived')&&state.projects.some(project=>project.id===task.projectId&&project.status==='active');
  const showProject=async projectId=>{
    const request=++folderRequest,other=projectId!==task.projectId;
    // A sharing confirmation covers one destination only; changing the project asks again.
    if(form.elements.confirmSharingChange)form.elements.confirmSharingChange.checked=false;
    note.hidden=!other;status.hidden=true;
    if(pickerFolders.has(projectId)){folderSelect.innerHTML=folderPickerOptions(pickerFolders.get(projectId),other?null:task.folderId);folderSelect.disabled=false;submit.disabled=false;return;}
    folderSelect.disabled=true;submit.disabled=true;folderSelect.innerHTML='<option value="">Loading folders…</option>';
    try{
      const response=await api(`/api/v1/projects/${encodeURIComponent(projectId)}/folders`,{recoveryGuard:current});
      if(request!==folderRequest||!current())return;
      if(!Array.isArray(response.folders))throw Error('Invalid folder response.');
      pickerFolders.set(projectId,response.folders.filter(folder=>folder.projectId===projectId));
      folderSelect.innerHTML=folderPickerOptions(pickerFolders.get(projectId),null);folderSelect.disabled=false;submit.disabled=false;
    }catch(error){
      if(request!==folderRequest||!current())return;
      folderSelect.innerHTML='<option value="">Project root</option>';folderSelect.disabled=false;submit.disabled=false;
      status.hidden=false;status.textContent=`Folders could not be loaded (${error.message}). You can still move the task to the project root.`;
    }
  };
  if(form.elements.projectId.tagName==='SELECT')form.elements.projectId.onchange=event=>void showProject(event.currentTarget.value);
  if(startProject!==task.projectId)void showProject(startProject);
  form.onsubmit=async event=>{event.preventDefault();if(!current()||folderSelect.disabled)return;
    const projectId=form.elements.projectId.value||task.projectId,folderId=folderSelect.value||null;
    if(projectId===task.projectId){
      if(folderId===task.folderId){modal.close();return;}
      await moveFolderTask(task,folderId,receipt,{originActive:current,onSuccess:()=>modal.close()});return;
    }
    const confirmSharingChange=Boolean(form.elements.confirmSharingChange?.checked);
    if(published&&!confirmSharingChange){status.hidden=false;status.textContent='Confirm the client access change to move this published task.';form.elements.confirmSharingChange.focus();return;}
    await moveProjectTask(task,projectId,folderId,receipt,{confirmSharingChange,originActive:current,onSuccess:()=>modal.close()});
  };
}
async function moveProjectTask(task,projectId,folderId,receipt,{undo=false,confirmSharingChange=false,originActive=()=>true,onSuccess}={}){
  if(!canMoveTaskAcrossProjects()||task.status==='archived'||!Number.isSafeInteger(task.folderRevision)||projectId===task.projectId)return;
  const authorized=folderAuthorizationGuard(task.projectId,'viewer.processing.write',{open:false});
  const current=()=>authorized()&&originActive()&&canMoveTaskAcrossProjects()&&state.tasks.some(value=>value.id===task.id&&value.projectId===task.projectId&&value.status!=='archived');
  const body={projectId,folderId,expectedProjectId:task.projectId,expectedFolderId:task.folderId??null,expectedFolderRevision:task.folderRevision,...(undo?{undo:true}:{}),confirmSharingChange};
  const destination=state.projects.find(project=>project.id===projectId)?.displayName||'the other project';
  let moved=null,focus={mode:'none'};
  const result=await mutateFolder(task.projectId,`/api/v1/tasks/${encodeURIComponent(task.id)}/project`,folderRequestOptions('PATCH',body,receipt),
    undo?'Task moved back':null,current,({task:updated,undoExpiresAt,serverTime}={})=>{
      if(updated?.id!==task.id||updated.projectId!==projectId||(updated.folderId??null)!==folderId||updated.folderRevision!==task.folderRevision+1){
        throw Error('Task move could not be confirmed. Check which project the task is in.');
      }
      projectDataGeneration++;
      focus=captureTaskMoveFocus(task.id);
      state.tasks=state.tasks.map(value=>value.id===updated.id?{...value,...updated}:value);
      state.outputs=state.outputs.map(output=>output.taskId===updated.id?{...output,projectId}:output);
      state.datasets=state.datasets.map(dataset=>dataset.id===updated.datasetId?{...dataset,projectId}:dataset);
      if(state.expandedTaskId===updated.id&&state.selectedProjectId!==projectId){state.expandedTaskId=null;state.taskPage=null;syncWorkspaceView('replace');}
      revealTaskDestination(projectId,folderId);
      moved={updated,undoExpiresAt,serverTime};
      onSuccess?.();
    },false);
  if(moved){
    // The destination project opens with the task's folder; its folders load first when needed.
    if(!folderCache.get(projectId)?.folders&&isProjectOpen(projectId))await loadProjectFolders(projectId);
    render();
    settleTaskMoveFocus(task.id,focus);
    flashTreeRow(`t:${task.id}`);
    announce(`${undo?'Moved back':'Moved'} ${task.displayName||'the task'} to ${treeLocationLabel(projectId,folderId)}.`);
    if(!undo){
      const previousProjectId=task.projectId,previousFolderId=task.folderId??null,updated=moved.updated;
      offerMoveUndo(`Task moved to ${destination}`,moved.undoExpiresAt,moved.serverTime,
        ()=>canMoveTaskAcrossProjects()&&state.tasks.some(value=>value.id===updated.id&&value.projectId===updated.projectId&&value.folderRevision===updated.folderRevision),
        async()=>{
          // Moving a published task back changes its audience again, so Undo asks the same question as the move.
          let confirmSharingChange=false;
          if(taskHasPublishedOutput(updated)){
            const origin=state.projects.find(project=>project.id===previousProjectId)?.displayName||'the previous project';
            if(!await dialogs.confirm(`This task is published. Moving it back to ${origin} removes it from the shares of ${destination} and shows it to clients of ${origin}.`,{title:'Move published task back',submitLabel:'Move back'}))return;
            confirmSharingChange=true;
          }
          return moveProjectTask(updated,previousProjectId,previousFolderId,{}, {undo:true,confirmSharingChange});
        });
    }
  }
  scheduleProjectRefresh(0);
  return result;
}
// ---- Delete a task: Recycle Bin with Undo ----
// Without a confirmation: the task and its owned source and outputs go to the Recycle Bin and
// Undo restores them for 10 s. A published task still asks first, because deleting it removes it
// from client shares at once and restoring does not publish it again; so does an account that
// cannot restore from the Recycle Bin.
// The same rules as the task menu: a writable task in an active project, with no live processing.
function taskWritable(task){return Boolean(task)&&task.status!=='archived'&&state.projects.find(project=>project.id===task.projectId)?.status==='active'&&can('viewer.processing.write')}
// Where focus goes when an Undo lands, decided when it runs: back to the restored row when the
// Undo control (now gone), the tree or nothing had focus; a control the user chose keeps it.
function captureUndoFocus(){
  const element=document.activeElement;
  if(!element||element===document.body||!element.isConnected||element.closest?.('#workspace-folder-undo,#project-list'))return{mode:'tree'};
  return{mode:'other',element,locate:focusLocator(element)};
}
function settleUndoFocus(focus,key){
  // Re-checked when the restore lands. Only lost focus (nothing, the page body or a removed node)
  // is restored; a live element the user went to meanwhile keeps focus, a tree row included. When
  // the Undo control or the tree had focus, the restored row also takes over focus still in the tree.
  const active=document.activeElement;
  const lost=!active||active===document.body||!active.isConnected;
  if(focus.mode==='tree'){if(lost||active.closest?.('#project-list'))focusTreeRow(key);return;}
  if(!lost)return;
  const target=focus.element.isConnected?focus.element:focus.locate?.();
  if(target)target.focus({preventScroll:true});
}
async function deleteTaskWithUndo(taskId){
  const task=state.tasks.find(item=>item.id===taskId);
  if(!task||state.busy||!taskWritable(task))return;
  if(LIVE_ATTEMPT_STATUSES.has(task.latestAttempt?.status))return toast('Stop processing before deleting this task.',true);
  const path=`/api/v1/tasks/${encodeURIComponent(task.id)}`;
  if(taskHasPublishedOutput(task))return trashMutation(`This task is published. Deleting it removes it from client shares now, and restoring it later does not publish it again. It can be restored until ${purgeDate(30)}; after that date it will be permanently purged.`,path,'Task moved to Recycle Bin');
  if(!can('viewer.storage.purge'))return trashMutation(`Delete this task and its exclusively owned dataset and outputs? It can be restored until ${purgeDate(30)}; after that date it will be permanently purged.`,path,'Task moved to Recycle Bin');
  const authorized=folderAuthorizationGuard(task.projectId,'viewer.processing.write',{open:false});
  state.busy=true;shell.setAttribute('aria-busy','true');
  let result=null;
  try{result=await api(path,{method:'DELETE',body:{},recoveryGuard:authorized});}
  catch(error){if(authorized())toast(error.message,true);}
  finally{state.busy=false;shell.removeAttribute('aria-busy');}
  if(!result||!authorized())return;
  projectDataGeneration++;
  const key=`t:${task.id}`,focus=captureTaskMoveFocus(task.id),wasExpanded=state.expandedTaskId===task.id;
  state.tasks=state.tasks.filter(item=>item.id!==task.id);
  if(wasExpanded){state.expandedTaskId=null;state.taskPage=null;syncWorkspaceView('replace');render();}
  else projectPaintPending=patchProjectTree(task.projectId,{movedTaskId:task.id})||projectPaintPending;
  if(focus.mode==='moved'||wasExpanded&&focus.mode==='none')placeTaskMoveFocus(task.id,{neighbourKey:focus.neighbourKey||`p:${task.projectId}`});
  else settleTaskMoveFocus(task.id,focus);
  announce(`Moved ${task.displayName||'the task'} to the Recycle Bin.`);
  // The Recycle Bin view reads storage; refresh it quietly so the deleted task is listed there.
  void pagedStorage().then(storage=>{state.storage=storage;if(state.section==='trash')render();}).catch(()=>{});
  const trashId=result.trash?.id;
  if(!trashId)return;
  offerUndo('Task moved to Recycle Bin',10_000,()=>can('viewer.storage.purge'),async()=>{
    const undoFocus=captureUndoFocus();
    state.busy=true;shell.setAttribute('aria-busy','true');
    try{await api(`/api/v1/storage/trash/${encodeURIComponent(trashId)}/restore`,{method:'POST',body:{}});}
    catch(error){toast(error.message,true);return;}
    finally{state.busy=false;shell.removeAttribute('aria-busy');}
    await load();
    settleUndoFocus(undoFocus,key);
    flashTreeRow(key);
    announce(`Restored ${task.displayName||'the task'}.`);
    toast('Task restored');
  });
}

// ---- Keyboard: treegrid with one tab stop ----
function treeRowControls(row){
  if(row.matches('.task-panel'))return[...row.querySelectorAll(':scope > .task-summary .task-quick-actions > button, :scope > .task-summary .task-quick-actions > details > summary')];
  return[...row.querySelectorAll(':scope .row-actions > button, :scope .row-actions > details > summary')];
}
function openTreeRowMenu(row){
  const menu=[...row.querySelectorAll('details.tree-menu')].find(item=>!item.closest('.task-detail-shell'));
  if(!menu)return;
  closeTreeMenus(menu);menu.open=true;
  menu.querySelector('.project-more-menu button:not(:disabled)')?.focus();
}
function treeMenuKeys(event,menu){
  const items=[...menu.querySelectorAll('.project-more-menu > button')].filter(item=>item.getClientRects().length);
  const index=items.indexOf(document.activeElement);
  if(event.key==='ArrowDown'){menu.open=true;items[(index+1)%items.length]?.focus();}
  else if(event.key==='ArrowUp'){menu.open=true;items[(index-1+items.length)%items.length]?.focus();}
  else if(event.key==='Home'&&index>-1)items[0]?.focus();
  else if(event.key==='End'&&index>-1)items.at(-1)?.focus();
  else if(event.key==='Escape'){menu.open=false;menu.querySelector('summary')?.focus();}
  else if(event.key==='Tab'){menu.open=false;return false;}
  else return false;
  event.preventDefault();event.stopPropagation();
  return true;
}
function treeKeydown(event){
  const inline=event.target.closest?.('.tree-inline-name');
  if(inline){
    if(event.key==='Enter'){event.preventDefault();void commitTreeName(inline);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void commitTreeName(inline,true);}
    return;
  }
  if(!event.target.closest?.('#project-list')||event.target.closest('.task-detail-shell'))return;
  const menu=event.target.closest('details.tree-menu');
  if(menu&&treeMenuKeys(event,menu))return;
  const row=event.target.closest('[data-tree-key]');if(!row)return;
  const target=row.querySelector('[data-tree-focus]'),key=row.dataset.treeKey;
  if(event.target!==target){
    // On a control in the row: Left/Right step between the row's controls, Escape returns to the row.
    const controls=treeRowControls(row),index=controls.indexOf(event.target);
    if(event.key==='ArrowRight'&&index>-1){event.preventDefault();controls[Math.min(index+1,controls.length-1)].focus();}
    else if(event.key==='ArrowLeft'&&index>-1){event.preventDefault();(index>0?controls[index-1]:target)?.focus();}
    else if(event.key==='Escape'&&index>-1){event.preventDefault();target?.focus();}
    return;
  }
  const targets=[...content.querySelectorAll('#project-list [data-tree-focus]')].filter(item=>item.getClientRects().length);
  const rows=targets.map(item=>{const owner=item.closest('[data-tree-key]');return{key:owner.dataset.treeKey,level:Number(owner.getAttribute('aria-level'))||1,expandable:/^[pf]:/.test(owner.dataset.treeKey),expanded:owner.getAttribute('aria-expanded')==='true'};});
  const index=targets.indexOf(target),move=treeKeyAction(rows,index,event.key);
  if(move){
    event.preventDefault();
    if(move.focus!==undefined)focusTreeRow(rows[move.focus].key);
    else if(move.toggle)target.click();
    else if(move.controls)treeRowControls(row).find(item=>item.getClientRects().length)?.focus();
    return;
  }
  const [kind,id]=[key.slice(0,1),key.slice(2)];
  if(event.key==='F2'){
    event.preventDefault();
    if(kind==='f')startFolderRename(row.dataset.treeProject,id);
    else if(kind==='t'&&taskWritable(state.tasks.find(task=>task.id===id)))editTask(id);
    else if(kind==='p'&&canWriteFolders(state.projects.find(project=>project.id===id)))editProject(id);
  }else if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();openTreeRowMenu(row);}
  else if(event.key==='Delete'&&kind==='t'){event.preventDefault();void deleteTaskWithUndo(id);}
}
content.addEventListener('keydown',treeKeydown);
content.addEventListener('focusin',event=>{
  const target=event.target.closest?.('#project-list [data-tree-focus]');
  if(!target)return;
  const key=target.closest('[data-tree-key]')?.dataset.treeKey;
  if(key&&key!==treeCurrentKey){treeCurrentKey=key;syncTreeTabStop();}
});
content.addEventListener('focusout',event=>{
  const input=event.target.closest?.('.tree-inline-name');
  // Leaving the name saves it, like pressing Enter; switching windows does not.
  if(input&&document.hasFocus())setTimeout(()=>{if(input.isConnected&&!input.disabled)void commitTreeName(input);},0);
});
// On phones a row menu opens as a bottom sheet. The project list is a size container, which would
// hold a fixed menu inside it, so the sheet goes to the top layer as a popover.
content.addEventListener('toggle',event=>{
  const menu=event.target;
  if(!(menu instanceof HTMLDetailsElement)||!menu.matches('.tree-menu'))return;
  const panel=menu.querySelector(':scope > .project-more-menu');
  if(menu.open){
    closeTreeMenus(menu);
    if(panel&&phoneLayout()&&typeof panel.showPopover==='function'){panel.popover='manual';try{panel.showPopover();}catch{panel.removeAttribute('popover');}}
  }else if(panel?.hasAttribute('popover')){try{panel.hidePopover();}catch{}panel.removeAttribute('popover');}
},true);
document.addEventListener('click',event=>{if(!event.target.closest?.('details.tree-menu'))closeTreeMenus();});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&content.querySelector('details.tree-menu[open]')&&!modal.open)closeTreeMenus();
  // Ctrl+Z (Cmd+Z) runs the offered Undo, except while typing.
  if((event.ctrlKey||event.metaKey)&&!event.shiftKey&&event.key.toLowerCase()==='z'&&folderUndo&&!modal.open&&!event.target.closest?.('input,textarea,select,[contenteditable]')){
    const control=document.querySelector('#workspace-folder-undo .toast-action');
    if(control){event.preventDefault();control.click();}
  }
});
function legacyImportModal(projectId,datasetId){const project=state.projects.find(item=>item.id===(projectId||state.datasets.find(dataset=>dataset.id===datasetId)?.projectId)),drafts=state.datasets.filter(dataset=>dataset.projectId===project?.id&&dataset.status==='draft');openModal(`Import into ${project?.displayName||'project'}`,`<div class="import-choice" role="tablist" aria-label="Import source"><button class="import-tab active" data-import-tab="device">This device</button><button class="import-tab" data-import-tab="server">Server import folder</button></div><section data-import-panel="device"><form id="upload-form" class="manage-form">${select('Draft dataset','datasetId',opts(drafts,'Select a draft'))}<label><span>Artifact role</span><select name="processingRole"><option value="auto">Detect automatically</option><option value="image">Source imagery</option><option value="provider_input">Model / orthophoto / point cloud</option><option value="gcp_source">GCP source</option></select></label>${field('Files','files','required type="file" multiple')}<button class="primary-button">Upload or resume</button><progress id="upload-progress" value="0" max="100"></progress></form><p class="form-note">Browser uploads are limited to 128 files, 64 MB each, and 256 MB total.</p></section><section data-import-panel="server" hidden><form id="server-import-form" class="manage-form"><input type="hidden" name="projectId" value="${esc(project?.id||'')}">${field('Task name','taskDisplayName','required maxlength="240"')}${field('Folder or backup ZIP','sourceRelativePath','required placeholder="incoming/task-folder or task.zip"')}<button class="primary-button">Queue structured task import</button></form><p class="form-note">This immediately queues a durable import from the managed server folder. The worker validates the folder or ZIP, detects supported task artifacts, and creates the task only after validation; there is no preview step.</p></section>`);modalContent.querySelectorAll('[data-import-tab]').forEach(tab=>tab.onclick=()=>{modalContent.querySelectorAll('[data-import-tab]').forEach(item=>item.classList.toggle('active',item===tab));modalContent.querySelectorAll('[data-import-panel]').forEach(panel=>panel.hidden=panel.dataset.importPanel!==tab.dataset.importTab)});const upload=modalContent.querySelector('#upload-form');if(datasetId)upload.elements.datasetId.value=datasetId;upload.onsubmit=event=>{event.preventDefault();uploadFiles(upload)};modalContent.querySelector('#server-import-form').onsubmit=event=>{event.preventDefault();modal.close();mutate('/api/v1/processing/server-task-imports',{method:'POST',body:values(event.currentTarget),headers:{'Idempotency-Key':crypto.randomUUID()}},'Server-folder import queued')}}
async function renderServerImportBrowser(path=''){
  const browser=modalContent.querySelector('#server-import-browser'),selection=modalContent.querySelector('input[name="sourceRelativePath"]'),submit=modalContent.querySelector('#server-import-form button[type="submit"]');
  if(!browser)return;browser.setAttribute('aria-busy','true');browser.innerHTML='<p class="form-note">Loading import folder…</p>';
  try{const page=await api(`/api/v1/processing/server-task-imports/browse?path=${encodeURIComponent(path)}&limit=100`),crumbs=page.path?page.path.split('/'):[];browser.innerHTML=`<div class="import-browser-heading"><nav class="import-breadcrumb" aria-label="Import folder"><button type="button" data-browse-path="">Imports</button>${crumbs.map((part,index)=>`<span>/</span><button type="button" data-browse-path="${esc(crumbs.slice(0,index+1).join('/'))}">${esc(part)}</button>`).join('')}</nav><button type="button" class="secondary-button" data-select-folder="${esc(page.path)}" data-select-kind="folder" ${page.path?'':'disabled'}>Select this folder</button></div><div class="import-browser-list">${page.entries.map(entry=>`<div class="import-browser-row"><span aria-hidden="true">${entry.kind==='folder'?'📁':'🗜️'}</span><strong>${esc(entry.name)}</strong><small>${entry.kind==='zip'?bytes(entry.byteSize):'Folder'}</small>${entry.kind==='folder'?`<button type="button" class="secondary-button" data-browse-path="${esc(entry.relativePath)}">Open</button><button type="button" class="secondary-button" data-select-path="${esc(entry.relativePath)}" data-select-kind="${entry.kind}">Select</button>`:`<button type="button" class="secondary-button" data-select-path="${esc(entry.relativePath)}" data-select-kind="${entry.kind}">Select ZIP</button>`}</div>`).join('')||empty('This folder has no importable folders or ZIP files.')}</div>${page.nextCursor?'<p class="form-note">This folder has more than 100 entries. Narrow it into subfolders before importing.</p>':''}`;browser.querySelectorAll('[data-browse-path]').forEach(button=>button.onclick=()=>renderServerImportBrowser(button.dataset.browsePath));browser.querySelectorAll('[data-select-path],[data-select-folder]').forEach(button=>button.onclick=()=>{const selected=button.dataset.selectPath??button.dataset.selectFolder;selection.value=selected;selection.dataset.sourceKind=button.dataset.selectKind;modalContent.querySelector('#server-import-selection').textContent=selected;submit.disabled=false;const name=selected.split('/').at(-1).replace(/\.zip$/i,'');const taskName=modalContent.querySelector('input[name="taskDisplayName"]');if(!taskName.value)taskName.value=name});}catch(error){browser.innerHTML=`<div class="empty-state">${esc(error.message)}</div><button type="button" class="secondary-button" id="retry-import-browser">Retry</button>`;browser.querySelector('#retry-import-browser').onclick=()=>renderServerImportBrowser(path)}finally{browser.removeAttribute('aria-busy')}
}
function importModal(projectId,datasetId){const project=state.projects.find(item=>item.id===(projectId||state.datasets.find(dataset=>dataset.id===datasetId)?.projectId)),drafts=state.datasets.filter(dataset=>dataset.projectId===project?.id&&dataset.status==='draft');openModal(`Import into ${project?.displayName||'project'}`,`<div class="import-choice" role="tablist" aria-label="Import source"><button class="import-tab active" data-import-tab="device">This device</button><button class="import-tab" data-import-tab="server">Server import folder</button></div><section data-import-panel="device"><form id="upload-form" class="manage-form">${select('Draft dataset','datasetId',opts(drafts,'Select a draft'))}<label><span>Artifact role</span><select name="processingRole"><option value="auto">Detect automatically</option><option value="image">Source imagery</option><option value="provider_input">Model / orthophoto / point cloud</option><option value="gcp_source">GCP source</option></select></label>${field('Files','files','required type="file" multiple')}<button class="primary-button">Upload or resume</button><progress id="upload-progress" value="0" max="100"></progress></form><p class="form-note">Browser uploads are limited to 128 files, 64 MB each, and 256 MB total.</p></section><section data-import-panel="server" hidden><form id="server-import-form" class="manage-form"><input type="hidden" name="projectId" value="${esc(project?.id||'')}"><input type="hidden" name="sourceRelativePath">${field('Task name','taskDisplayName','required maxlength="240"')}<div id="server-import-browser" class="import-browser" aria-live="polite"></div><p>Selected: <strong id="server-import-selection">Nothing selected</strong></p><button type="submit" class="primary-button" disabled>Queue selected source</button></form><p class="form-note">Browse the persistent server import folder and select a folder or ZIP. Import copies and validates the source; it never removes the original automatically.</p></section>`);modalContent.querySelectorAll('[data-import-tab]').forEach(tab=>tab.onclick=()=>{modalContent.querySelectorAll('[data-import-tab]').forEach(item=>item.classList.toggle('active',item===tab));modalContent.querySelectorAll('[data-import-panel]').forEach(panel=>panel.hidden=panel.dataset.importPanel!==tab.dataset.importTab);if(tab.dataset.importTab==='server')renderServerImportBrowser('')});const upload=modalContent.querySelector('#upload-form');if(datasetId)upload.elements.datasetId.value=datasetId;upload.onsubmit=event=>{event.preventDefault();uploadFiles(upload)};modalContent.querySelector('#server-import-form').onsubmit=event=>{event.preventDefault();modal.close();mutate('/api/v1/processing/server-task-imports',{method:'POST',body:values(event.currentTarget),headers:{'Idempotency-Key':crypto.randomUUID()}},'Server-folder import queued')}}
let activeNewTask=null;
// duplicate pre-fills the dialog from another task (see mountNewTask); the copy is created only when the user starts it.
function processModal(projectId,duplicate=null){
  const project=state.projects.find(item=>item.id===projectId);if(!project||project.status!=='active'||!can('viewer.processing.write'))return;
  if(activeNewTask?.active){if(duplicate)toast('Finish or close the open New task first.',true);activeNewTask.reopen();return;}
  // Separate from the shared workspace modal: navigating or opening another
  // settings dialog must not destroy a browser-owned photo upload.
  const taskDialog=document.createElement('dialog');taskDialog.className='workspace-modal';taskDialog.setAttribute('aria-label',duplicate?'Duplicate task':'New processing task');
  const taskContent=document.createElement('div');taskContent.innerHTML='<div class="modal-heading"><div><p class="eyebrow">Viewer workspace</p><h2></h2></div><button type="button" class="icon-button modal-close" aria-label="Close task dialog">×</button></div>';taskContent.querySelector('h2').textContent=duplicate?'Duplicate task':'New task';
  taskDialog.append(taskContent);document.body.append(taskDialog);taskContent.querySelector('.modal-close').onclick=()=>taskDialog.close();
  activeNewTask=mountNewTask({container:taskContent,dialog:taskDialog,project,providers:state.providers,presets:state.presets,datasets:state.datasets,api,fetcher:workspaceFetch,token:()=>state.token,canUpload:can('viewer.datasets.write'),canImport:can('viewer.datasets.import'),canManagePresets:can('viewer.providers.write'),allowBackground:true,duplicate,onDispose:()=>{taskDialog.remove();activeNewTask=null;},onComplete:async result=>{toast(duplicate?'Duplicate task submitted':'Processing task submitted');if(duplicate)revealTaskDestination(project.id,duplicate.folderId);await load();const copyId=result?.task?.id;if(duplicate&&copyId&&state.tasks.some(item=>item.id===copyId)){if(state.expandedTaskId!==copyId)void expandTask(copyId);focusTreeRow(`t:${copyId}`);}}});taskDialog.showModal();
}
// Duplicate: a new task in the same project and folder on the same source photos (not copied), with the latest run's
// node, preset and options, named "<name> (copy)". It opens the New task dialog pre-filled, so nothing starts until the
// user reviews it and chooses Start processing. Outputs, publication, shares and client visibility are not copied.
function duplicateTask(id){
  const task=state.tasks.find(item=>item.id===id);if(!task||task.status==='archived'||!can('viewer.processing.write'))return;
  // Trim by whole characters (never half an emoji) so the name plus " (copy)" stays within the 240-unit limit.
  const attempt=task.latestAttempt||{};let base='';for(const character of String(task.displayName||'Task')){if(base.length+character.length>240-' (copy)'.length)break;base+=character;}
  return processModal(task.projectId,{sourceTaskId:task.id,displayName:`${base} (copy)`,datasetId:task.datasetId,folderId:task.folderId??null,providerId:attempt.providerId||'',presetId:attempt.presetId||'',options:attempt.options||{}});
}
async function editTask(id){const task=state.tasks.find(item=>item.id===id);if(!task)return;const input=await dialogs.form({title:'Edit task',submitLabel:'Save task',fields:[{name:'displayName',label:'Task name',value:task.displayName||'',required:true,maxLength:240},{name:'description',label:'Description',value:task.description||'',multiline:true,maxLength:4000}]});if(!input)return;await mutate(`/api/v1/tasks/${encodeURIComponent(id)}`,{method:'PATCH',body:input},'Task updated')}
async function confirmCancelAttempt(id){if(!can('viewer.processing.write')||state.busy)return;const confirmed=await dialogs.confirm('Stop this processing run? Your source photos and previously published models will be kept.',{title:'Cancel processing run',submitLabel:'Cancel processing',destructive:true});if(!confirmed||state.busy||!can('viewer.processing.write'))return;return mutate(`/api/v1/attempts/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}},'Attempt cancelled')}
async function restartTask(id){const task=state.tasks.find(item=>item.id===id),attempt=task?.latestAttempt;if(!attempt?.providerId)return toast('The task has no prior provider configuration',true);return mutate(`/api/v1/tasks/${encodeURIComponent(id)}/attempts`,{method:'POST',body:{providerId:attempt.providerId,...(attempt.presetId?{presetId:attempt.presetId}:{}),options:attempt.options||{}}},'New processing attempt queued')}
async function readyViewerLauncher(){const launch=beginIsolatedViewerLaunch();if(!await launch.waitUntilReady())throw new Error('Viewer popup was blocked or failed to initialize');return launch}
async function openReview(id){let launch=null;try{launch=await readyViewerLauncher();const result=await api(`/api/v1/attempts/${encodeURIComponent(id)}/review-sessions`,{method:'POST',body:{}});if(!reviewSessionController.track(launch.channelId,{attemptId:result.attemptId,modelId:result.modelId,modelVersionId:result.modelVersionId,sessionTtlSeconds:result.sessionTtlSeconds}))throw responseError('invalid review session response',502);if(!launch.navigate(result.embedUrl,{renewable:true}))throw responseError('invalid review navigation response',502);setTimeout(()=>launch.close(),1000)}catch(error){launch?.fail();if(launch)reviewSessionController.untrack(launch.channelId);toast(error.message,true)}}
async function publishAttempt(id){try{const result=await api(`/api/v1/attempts/${encodeURIComponent(id)}/review-sessions`,{method:'POST',body:{}});if(await dialogs.confirm(`Publish the verified ${result.assetKinds.join(', ')} assets?`,{title:'Publish output',submitLabel:'Publish'}))await mutate(`/api/v1/attempts/${encodeURIComponent(id)}/publish`,{method:'POST',body:{selectedAssetKinds:result.assetKinds}},'Output published')}catch(error){toast(error.message,true)}}
async function viewPublishedOutput(id){let launch=null;try{launch=await readyViewerLauncher();const result=await api(`/api/v1/processing/outputs/${encodeURIComponent(id)}/view-sessions`,{method:'POST',body:{}});if(result.sessionMode!=='published'||!reviewSessionController.track(launch.channelId,{sessionMode:'published',outputId:id,modelId:result.modelId,modelVersionId:result.modelVersionId,sessionTtlSeconds:result.sessionTtlSeconds}))throw responseError('invalid Viewer session response',502);if(!launch.navigate(result.embedUrl,{renewable:true}))throw responseError('invalid Viewer session response',502);setTimeout(()=>launch.close(),1000)}catch(error){launch?.fail();if(launch)reviewSessionController.untrack(launch.channelId);toast(error.message,true)}}
async function downloadOutputAsset(id,url,isReport){const output=state.outputs.find(item=>item.id===id);if(!isReport)return outputDownloadMenu(output);if(!url)return toast('This output does not expose that artifact',true);try{await authenticatedDownload(url,`${safeFileName(output?.displayName)}-report.pdf`)}catch(error){toast(error.message,true)}}
async function purgeTrash(id,entityId){const input=await dialogs.form({title:'Permanently delete item',message:`Permanent deletion cannot be undone. Type the exact identifier to continue: ${entityId}`,submitLabel:'Permanently delete',destructive:true,fields:[{name:'typedId',label:'Exact identifier',required:true,maxLength:entityId.length,exact:entityId}]});if(!input)return;return mutate(`/api/v1/storage/trash/${encodeURIComponent(id)}`,{method:'DELETE',body:{typedId:input.typedId}},'Item permanently deleted')}
async function importGcp(event){event.preventDefault();const form=event.currentTarget,file=form.elements.file.files[0];if(!file)return;const format=form.elements.format.value,contentText=await file.text(),previewPath=`/api/v1/datasets/${encodeURIComponent(form.dataset.datasetId)}/gcp-sets/import-preview`;let declarations,preview;try{preview=await api(previewPath,{method:'POST',body:{format,content:contentText}})}catch(error){if(format!=='emlid-all-columns-v1'||!error.message.includes('units are not explicit'))return toast(error.message,true);const input=await dialogs.form({title:'Declare GCP units',message:'This file does not declare projected units. Choose the units used by its survey coordinates.',submitLabel:'Continue',fields:[{name:'linearUnit',label:'Projected units',required:true,options:[{value:'',label:'Choose units…'},{value:'m',label:'Meters (m)'},{value:'ftUS',label:'US survey feet (ftUS)'}],value:''}]});if(!input)return;declarations={linearUnit:input.linearUnit};try{preview=await api(previewPath,{method:'POST',body:{format,content:contentText,declarations}})}catch(retryError){return toast(retryError.message,true)}}const body={displayName:form.elements.displayName.value,format,fileName:file.name,content:contentText,...(declarations?{declarations}:{})};openModal('Confirm GCP import',`<div class="gcp-preview"><p>The API parsed <strong>${preview.pointCount}</strong> points. Confirm this authoritative mapping before writing the set.</p><dl class="detail-list"><div><dt>Point identifier</dt><dd>${esc(preview.columns?.id||'Unavailable')}</dd></div><div><dt>Survey coordinates</dt><dd>${esc((preview.columns?.authoritative||[]).join(', ')||'Unavailable')}</dd></div><div><dt>Cross-check only</dt><dd>${esc((preview.columns?.crossCheck||[]).join(', ')||'Unavailable')}</dd></div><div><dt>Coordinate system</dt><dd>${esc(preview.provenance?.coordinateSystem||'Unavailable')}</dd></div><div><dt>Vertical datum</dt><dd>${esc(preview.provenance?.verticalDatum||'Unavailable')}</dd></div><div><dt>Linear unit</dt><dd>${esc(preview.provenance?.linearUnit||'Unavailable')}</dd></div></dl>${(preview.warnings||[]).map(warning=>`<p class="form-note">Warning: ${esc(warning)}</p>`).join('')}<div class="row-actions"><button class="secondary-button modal-cancel">Cancel</button><button class="primary-button gcp-confirm">Confirm import</button></div></div>`);modalContent.querySelector('.modal-cancel').onclick=()=>modal.close();modalContent.querySelector('.gcp-confirm').onclick=async()=>{modal.close();await mutate(`/api/v1/datasets/${encodeURIComponent(form.dataset.datasetId)}/gcp-sets/import`,{method:'POST',body:{...body,confirmationToken:preview.confirmationToken}},'GCP set imported');await refreshTaskDetails(form.dataset.taskId)}}

function associationModelId(item){return item?.modelId||item?.model_id||item?.viewerModelId||item?.viewer_model_id||null}
function associationProjectId(item){return item?.projectId||item?.project_id||null}
function portalAccountId(item){return item?.accountId||item?.account_id||null}
function clientProjectKey(project){return JSON.stringify([project.id,portalAccountId(project)])}
function clientProjectLabel(project){return `${project.clientName||project.client_name||'Client'} — ${project.name||project.projectName||project.project_name||project.id} · ${project.nativeTarget?`${project.nativeTarget.sourceId} · ${project.accountName}`:project.accountName||portalAccountId(project)}`}
function clientAccessSnapshot(legacy=state.clientAccess,native=state.clientNativeAccess){
  const access=legacy||{projects:[],associations:[],grants:[]};
  if(!native)return access;
  const projects=(native.targets||[]).map(target=>({id:JSON.stringify([target.sourceId,target.workspaceId,target.projectPublicId]),accountId:target.workspaceId,accountName:target.workspaceName,clientName:target.workspaceName,projectName:target.projectName,nativeTarget:target}));
  return {...access,projects:[...(access.projects||[]),...projects],
    associations:[...(access.associations||[]),...projects.flatMap(project=>(project.nativeTarget.associations||[]).map(item=>({...item,projectId:project.id,accountId:project.accountId})))],
    grants:[...(access.grants||[]),...(native.grants||[]).map(grant=>({...grant,native:true,projectId:JSON.stringify([grant.source_id,grant.workspace_id,grant.project_public_id]),accountId:grant.workspace_id,clientName:grant.workspace_name,projectName:grant.project_name,scopeType:grant.scope_type,associationId:grant.association_id}))]};
}
function exactClientAssociations(output,access=clientAccessSnapshot()){
  if(!output?.activePublished||output.status!=='published'||!output.modelId)return[];
  const projects=access?.projects||[],associations=access?.associations||[];
  return associations.flatMap(item=>{
    if(!item.id||associationModelId(item)!==output.modelId)return[];
    return projects.filter(project=>project.id===associationProjectId(item)&&portalAccountId(project)
      &&(!portalAccountId(item)||portalAccountId(item)===portalAccountId(project))
      &&associations.filter(other=>associationModelId(other)===output.modelId&&associationProjectId(other)===project.id).length===1)
      .map(project=>({...item,accountId:portalAccountId(project),selectionKey:JSON.stringify([item.id,project.id,portalAccountId(project)])}));
  });
}
function clientGrantBody(form,onlyOutputId){
  const projects=clientAccessSnapshot().projects||[];
  let project,association=null;
  if(onlyOutputId){
    const output=state.outputs.find(item=>item.id===onlyOutputId);
    association=exactClientAssociations(output).find(item=>item.selectionKey===form.elements.associationId.value);
    project=association&&projects.find(item=>item.id===associationProjectId(association)&&portalAccountId(item)===portalAccountId(association));
    if(!association||!project)throw new Error('An exact Operations model association is required for this model.');
  }else{
    project=projects.find(item=>clientProjectKey(item)===form.elements.projectId.value);
    if(!project||!portalAccountId(project)||!form.elements.wholeProject.checked)
      throw new Error('Select an Operations project and explicitly approve whole-project access.');
    if(!form.elements.includeFuturePublished.checked)throw new Error('Project access must include current and future published tasks.');
  }
  const native=project.nativeTarget;
  return{...(native?{connection:'native'}:{}),grant:{...(native?{sourceId:native.sourceId,workspaceId:native.workspaceId,projectPublicId:native.projectPublicId}:{accountId:portalAccountId(project),projectId:project.id}),scopeType:onlyOutputId?'task':'project',
    associationId:association?.id||null,includeFuturePublished:!onlyOutputId,
    expiresAt:form.elements.expiresAt.value?new Date(form.elements.expiresAt.value).toISOString():null,
    permissions:{measure:form.elements.measure.checked,cameras:form.elements.cameras.checked,download:form.elements.download.checked}}};
}
function clientSharePanel(output,onlyOutputId){
  const legacy=legacyClientSharePanel(output,onlyOutputId);
  if(state.clientDirectAccess)return directClientShareCard(onlyOutputId)
    +`<details class="share-legacy"><summary>Share through an Operations project instead</summary><div data-legacy-client-share-panel>${legacy}</div></details>`;
  return legacy;
}
function legacyClientSharePanel(output,onlyOutputId){
  if(can('viewer.client_grants.manage')&&state.shareContext?.clientLoading)return card('Authenticated client access',empty('Checking Operations client access… Public links can be created separately.'));
  if(can('viewer.client_grants.manage')&&state.shareContext?.clientError&&!state.clientNativeAccess?.targets?.length){
    const diagnostic=clientAccessDiagnostic(state.shareContext.clientError);
    const details=[diagnostic.status?`HTTP ${diagnostic.status}`:null,diagnostic.code?`Code: ${diagnostic.code}`:null].filter(Boolean).join(' · ');
    return card('Authenticated client access',empty('Operations client access could not be loaded. Close and reopen Share to retry. Public links are unaffected.')
      +(details?`<p class="form-note">${esc(details)}</p>`:'')
      +`<p class="form-note">${diagnostic.requestId?`Reference: ${esc(diagnostic.requestId)}. Share this reference with your administrator.`:'No proxy reference was returned; this alone does not identify the failure stage.'}</p>`);
  }
  return clientShareCard(output,onlyOutputId);
}
function directShareContext(onlyOutputId){
  const projectId=state.shareContext.projectId,project=state.projects.find(item=>item.id===projectId);
  const taskId=onlyOutputId?state.shareContext.taskId||null:null,task=taskId?state.tasks.find(item=>item.id===taskId):null;
  return {projectId,projectName:project?.displayName||'this project',tasks:shareableTasks(projectId,state.tasks,state.outputs),
    entry:onlyOutputId?'task':'project',taskId,taskName:onlyOutputId?state.shareContext.taskName||'':'',
    // The task and the model it was opened on must both still be there, in this project.
    targetMissing:Boolean(onlyOutputId)&&!(task?.projectId===projectId&&state.outputs.some(output=>output.id===onlyOutputId&&output.taskId===taskId))};
}
function directClientShareCard(onlyOutputId){
  const context=directShareContext(onlyOutputId),access=state.clientDirectAccess;
  return card('Share with a client',`${directShareForm(context)}<h3 class="direct-share-heading">Clients with access</h3>${directGrantRows(access,{...context,dateTime,groups:state.clientDirectGroups})}`);
}
function rerenderClientSharePanel(projectId,onlyOutputId){
  const panel=modalContent.querySelector('[data-client-share-panel]');
  if(panel){panel.querySelector?.('#direct-client-grant-form')?.clientPicker?.dispose();panel.innerHTML=clientSharePanel(state.outputs.find(output=>output.id===onlyOutputId),onlyOutputId);bindShareModal(projectId,onlyOutputId);}
}
function bindDirectShare(form,projectId,onlyOutputId){
  const context=directShareContext(onlyOutputId),shareContext=state.shareContext,live=()=>state.shareContext===shareContext&&form.isConnected&&modal.open;
  let picked=null,fresh=false;const read=()=>readDirectShareForm(form,{...context,tasks:directShareContext(onlyOutputId).tasks||context.tasks,known:context.tasks,fresh,clients:picked?[picked]:[]});
  const summary=form.querySelector('[data-direct-summary]'),taskInputs=[...form.querySelectorAll('input[name="taskId"]')];
  const review=form.querySelector('[data-direct-review]'),reviewButton=form.querySelector('[data-direct-review-button]');
  // Review step: the choices are frozen and repeated in plain words before anything is sent.
  // It is the confirmation: only its Share button sends, and any change of the choices goes back through it.
  const setReviewing=on=>{
    form.reviewing=on;if(!on)form.reviewed=null;review.hidden=!on;reviewButton.hidden=on;
    for(const element of form.querySelectorAll('fieldset,input[name="expiresAt"],input[name="measure"],input[name="cameras"],input[name="download"]'))element.disabled=on;
    if(!on)sync();
  };
  const sync=()=>{const current=read();for(const input of taskInputs)input.disabled=current.scope!=='tasks';
    const later=form.elements.includeLater,off=current.scope!=='project';if(later&&later.disabled!==off){later.disabled=off;later.checked=!off}summary.textContent=current.summary};
  form.onchange=()=>form.reviewing?setReviewing(false):sync();
  form.querySelector('[data-direct-back]').onclick=()=>setReviewing(false);
  // The second click of a double-click on Review share must not land on Share.
  const send=form.querySelector('[data-direct-send]');if(send)send.onclick=event=>{if(event.detail>1)event.preventDefault()};
  // Type-to-filter picker: each keystroke (debounced) asks the server, and an older answer never replaces a newer one.
  // Choosing a client only fills the form; the review and its Share button are still required.
  const pickerRoot=form.querySelector('[data-client-picker]');
  // Search-first: no client is listed until staff type at least two characters.
  const destination=form.querySelector('[data-direct-destination]');
  if(pickerRoot)form.clientPicker=bindClientPicker(pickerRoot,{initial:null,groupOf:directClientGroupOf(state.clientDirectGroups),
    fetchPage:async({query,cursor,signal})=>{
      const result=directClientAccess(await api(directClientsPath(projectId,{query,cursor,include:'clients'}),{signal}));
      if(!result)throw new Error('Clients could not be loaded.');if(!live())throw new Error('Share dialog closed');return result;
    },
    onSelect:(client,pickerLabel)=>{
      // Any change of client, including clearing it, needs a fresh review for the new recipient.
      picked=client?{...client,...(pickerLabel?{pickerLabel}:{})}:null;if(destination)destination.innerHTML=directDestinationMarkup(picked);
      if(form.reviewing)setReviewing(false);else if(form.isConnected)sync()}});
  sync();
  // Pinned to this modal (shareContext above): a late result must not touch a different Share dialog.
  form.onsubmit=async event=>{
    event.preventDefault();if(form.shareBusy)return;
    if(directShareContext(onlyOutputId).targetMissing){if(form.reviewing)setReviewing(false);summary.textContent=SHARE_TARGET_MISSING;return}
    let bodies,target;const choices=confirmed=>{target=read();const key=JSON.stringify([target.bodies(),target.what,target.published,target.client&&directClientKey(target.client)]);bodies=target.bodies({confirmed});return key};
    let chosen;try{chosen=choices(form.reviewing===true)}catch(error){if(form.reviewing)setReviewing(false);summary.textContent=error.message;return}
    if(!form.reviewing){
      // What is published now is read again before the review.
      const client=picked,asked=JSON.stringify(bodies);form.shareBusy=true;summary.textContent='Preparing the review…';
      try{fresh=await refreshProjectOutputs(projectId).then(read=>read===true,()=>false)}finally{form.shareBusy=false}
      if(!live())return;
      if(directShareContext(onlyOutputId).targetMissing){summary.textContent=SHARE_TARGET_MISSING;return}
      if(picked!==client){sync();return}
      try{chosen=choices(false)}catch(error){summary.textContent=error.message;return}
      if(JSON.stringify(bodies)!==asked){sync();return}
      // The review says it all; the line above it is for progress and refusals.
      summary.textContent='';
      const body=bodies[0];form.reviewed=chosen;
      form.querySelector('[data-direct-review-text]').innerHTML=directShareReviewMarkup({client:target.client,what:target.what,permissions:body.permissions,expiresAt:body.expiresAt,dateTime});
      // Focus the review, not Share: a held Enter key must not send.
      setReviewing(true);review.focus?.();return;
    }
    // What was reviewed is what is sent; anything that changed since goes back to the form.
    if(form.reviewed!==chosen){setReviewing(false);summary.textContent='Something changed since the review. Check it and review again.';return}
    // Inputs stay frozen while sending so the summary always matches what is being shared.
    const controls=[...form.querySelectorAll('input,select,button')].map(element=>[element,element.disabled]);
    for(const [element] of controls)element.disabled=true;
    form.shareBusy=true;form.requestKeys||=new Map();let shared=0,refusal='';summary.textContent=`Sharing… ${target.summary}`;
    try{
      for(const body of bodies){
        const serialized=JSON.stringify(body);if(!form.requestKeys.has(serialized))form.requestKeys.set(serialized,crypto.randomUUID());
        await api(DIRECT_CLIENT_GRANTS_PATH,{method:'POST',body,headers:{'Idempotency-Key':form.requestKeys.get(serialized)}});shared++;
      }
      toast(bodies.length>1?`Shared ${shared} tasks with the client`:'Shared with the client');
    }catch(error){
      toast(directShareErrorText(error),true);
      refusal=(shared?`Shared ${shared} of ${bodies.length}. Share again to finish; already shared tasks are not duplicated. `:'')+directShareErrorText(error);
    }finally{form.shareBusy=false;if(form.isConnected){for(const [element,disabled] of controls)element.disabled=disabled;if(shared!==bodies.length)setReviewing(false)}}
    // After the form is open again, which shows its choices: the reason stays until one of them changes.
    if(refusal&&live())summary.textContent=refusal;
    // A partial share keeps the form and its retry keys exactly as they were.
    if(shared!==bodies.length||!live())return;
    try{const result=await loadDirectClientAccess(api,projectId);if(result&&live())state.clientDirectAccess=result}catch{}
    if(live())rerenderClientSharePanel(projectId,onlyOutputId);
  };
}
function clientShareCard(output,onlyOutputId){
  if(!can('viewer.client_grants.manage'))return card('Authenticated client access',empty('Client-access management requires an additional permission.'));
  const access=clientAccessSnapshot();
  if(!state.clientAccess&&!state.clientNativeAccess)return card('Authenticated client access',empty('Operations client access is unavailable. No access has been granted.'));
  const associations=onlyOutputId?exactClientAssociations(output):[],projects=access.projects||[];
  let form='';
  if(onlyOutputId&&(!output?.activePublished||output.status!=='published')){
    form=empty('Direct Operations client sharing is not available for this private ready model yet. Its verified activation and exact Operations association must be connected first; creating a public link is a separate choice, not a prerequisite for client access.');
  }else if(onlyOutputId&&!associations.length){
    form=empty('No unique Operations association matches this model. Set up its model association in Operations first. Other models and entire client projects will not be granted access here.');
  }else{
    const target=onlyOutputId
      ?`<label><span>Client Portal project for this exact model</span><select name="associationId" required><option value="">Select client project</option>${associations.map(item=>{const project=projects.find(project=>project.id===associationProjectId(item)&&portalAccountId(project)===portalAccountId(item));return`<option data-portal="${project.nativeTarget?'native':'legacy'}" value="${esc(item.selectionKey)}">${esc(clientProjectLabel(project))}</option>`}).join('')}</select></label><p class="form-note">Only this model. Future published tasks are not included.</p>`
      :`<label><span>Operations client project</span><select name="projectId" required><option value="">Select client project</option>${projects.filter(portalAccountId).map(project=>`<option data-portal="${project.nativeTarget?'native':'legacy'}" value="${esc(clientProjectKey(project))}">${esc(clientProjectLabel(project))}</option>`).join('')}</select></label><label class="check"><input type="checkbox" name="wholeProject" required> Grant the entire selected Operations project, not just one Viewer model</label><label class="check"><input type="checkbox" name="includeFuturePublished" required> Include current and future published tasks</label>`;
    form=`<form id="client-grant-form" class="manage-form share-dialog-form"><label><span>Portal connection</span><select name="portalConnection"><option value="legacy">Operations client accounts</option>${projects.some(project=>project.nativeTarget)?`<option value="native" ${projects.some(project=>!project.nativeTarget)?'':'selected'}>Connected Client Workspaces</option>`:''}</select></label>${target}${field('Expiry (optional)','expiresAt','type="datetime-local"')}<label class="check"><input type="checkbox" name="measure" checked> Measurements</label><label class="check"><input type="checkbox" name="cameras" checked> Camera positions</label><label class="check"><input type="checkbox" name="download"> Downloads</label><button class="primary-button">Grant client access</button></form>`;
  }
  const localModels=new Set(state.outputs.filter(item=>(item.projectId||state.tasks.find(task=>task.id===item.taskId)?.projectId)===state.shareContext?.projectId).map(item=>item.modelId).filter(Boolean));
  const related=(access.associations||[]).filter(item=>localModels.has(associationModelId(item))),projectIds=new Set(related.map(associationProjectId));
  const ids=new Set((onlyOutputId?associations:related).map(item=>item.id)),grants=(access.grants||[]).filter(grant=>onlyOutputId
    ?((grant.scopeType||grant.scope_type)==='task'&&ids.has(grant.associationId||grant.association_id))
    :projectIds.has(grant.projectId||grant.project_id));
  return card('Authenticated client access',(state.shareContext?.nativeError?'<p class="form-note" role="status">Connected Client Workspaces could not be loaded. Close and reopen Share to retry. Operations client account sharing remains available.</p>':'')+form+`<div class="data-list top-gap">${grants.map(grant=>`<div class="manage-row"><div><strong>${esc(grant.clientName||grant.client_name||grant.accountId)}</strong><small>${esc(grant.projectName||grant.project_name||grant.projectId)}</small></div>${badge(grant.status||'active')}<div>${(grant.status||'active')==='active'?button(grant.native?'revoke-native-client-grant':'revoke-client-grant',grant.id,'Revoke'):''}</div></div>`).join('')||empty('No matching authenticated client grants.')}</div>`);
}
function rememberShareResult(result,projectId,outputId){
  state.lastShareUrl=result.viewUrl;state.lastShareOutputId=outputId;
  state.lastShareResult={url:result.viewUrl,projectId,outputId,shareId:result.share.id,
    kind:outputId?'model':'project',expiresAt:result.share.expiresAt||null};
}
function clearShareResult(shareId,kind){
  if(state.lastShareResult?.shareId!==shareId||state.lastShareResult.kind!==kind)return;
  state.lastShareResult=null;state.lastShareUrl=null;state.lastShareOutputId=null;
}
function visibleShareResult(projectId,onlyOutputId){
  const result=state.lastShareResult;
  if(!result?.shareId||result.projectId!==projectId||result.url!==state.lastShareUrl
    ||(onlyOutputId&&result.outputId!==onlyOutputId))return null;
  const shares=result.kind==='project'?state.projectShares[result.projectId]:state.shares[result.outputId];
  const loaded=shares?.find(share=>share.id===result.shareId);
  const expiry=loaded?.expiresAt||result.expiresAt;
  if(loaded?.revokedAt||(expiry&&(!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now()))){
    clearShareResult(result.shareId,result.kind);return null;
  }
  return result;
}
function shareViewLabels(){return {model:'3D model',pointCloud:'Point cloud',ortho:'Orthophoto',dsm:'DSM',dtm:'DTM'}}
function availableShareViews(output){
  const kinds=new Set(state.sharePreflight[output.id]?.eligibleAssetKinds||output.assetKinds||[]),mapping={model:['glb','tiles'],pointCloud:['ept'],ortho:['ortho'],dsm:['dsm'],dtm:['dtm']};
  return Object.keys(mapping).filter(view=>mapping[view].some(kind=>kinds.has(kind)));
}
function shareViewControls(output,allowedViews=null){
  const views=availableShareViews(output),selected=allowedViews===null?views:allowedViews,labels=shareViewLabels();
  return `<fieldset class="share-view-controls"><legend>Available views</legend><label class="check"><input type="checkbox" data-all-share-views ${views.length&&views.every(view=>selected.includes(view))?'checked':''}> All available views</label><details><summary>Choose individual views</summary><div class="share-view-list">${views.map(view=>`<label class="check"><input type="checkbox" name="allowedViews" value="${view}" ${selected.includes(view)?'checked':''}> ${labels[view]}</label>`).join('')||'<p class="form-note">No verified views are available.</p>'}</div></details></fieldset>`;
}
function bindShareViewControls(form){
  const all=form.querySelector('[data-all-share-views]'),inputs=[...form.querySelectorAll('input[name="allowedViews"]')];if(!all)return;
  const sync=()=>{const count=inputs.filter(input=>input.checked).length;all.checked=inputs.length>0&&count===inputs.length;all.indeterminate=count>0&&count<inputs.length;};
  all.onchange=()=>{form.shareViewsChanged=true;for(const input of inputs)input.checked=all.checked;sync()};
  for(const input of inputs)input.onchange=()=>{form.shareViewsChanged=true;sync()};
  sync();
}
function selectedShareViews(form){
  const selected=[...form.querySelectorAll('input[name="allowedViews"]')].filter(input=>input.checked).map(input=>input.value);
  if(!selected.length)throw new Error('Allow at least one available view.');return selected;
}
function shareSettingsSummary(share){
  const labels=shareViewLabels(),views=share.allowedViews===null||share.allowedViews===undefined?'All available views':share.allowedViews.map(view=>labels[view]||view).join(', ');
  return `${views} · ${share.permissions?.measure?'Temporary measurements':'No measurements'} · ${share.permissions?.cameras?'Camera positions':'No camera positions'} · ${share.permissions?.download?'Downloads enabled':'No downloads'} · ${share.hasPassword?'Password protected':'No password'} · ${!share.expiresAt?'No expiry':Number.isNaN(Date.parse(share.expiresAt))?'End date unknown':`Expires ${dateTime(share.expiresAt)}`}`;
}
// One rule for a public link everywhere in the dialog, the server's own (publicShareLive, projectShareLive):
// an unreadable expiry is expired.
function publicLinkState(share,now=Date.now()){
  return share.revokedAt?'revoked':share.expiresAt&&!(Date.parse(share.expiresAt)>now)?'expired':'active';
}
// Links that still open count on the tab, so a live link is never hidden behind it.
function publicTabLabel(shares){
  const live=(shares||[]).filter(share=>publicLinkState(share)==='active').length;
  return live?`Public link (${live})`:'Public link';
}
function shareModal(projectId,onlyOutputId=null){
  const project=state.projects.find(item=>item.id===projectId),selected=state.outputs.find(output=>output.id===onlyOutputId),checking=state.shareContext?.loading===true;
  const mode=state.shareContext?.mode==='public'?'public':'internal',task=state.tasks.find(item=>item.id===selected?.taskId);
  if(!onlyOutputId)visibleShareResult(projectId,onlyOutputId);
  const result=onlyOutputId&&visibleShareResult(projectId,onlyOutputId)?card('Public link',`<div class="share-result"><input readonly aria-label="New public link" value="${esc(state.lastShareUrl)}"><button class="primary-button" data-action="copy-share" data-url="${esc(state.lastShareUrl)}">Copy</button></div>`):'';
  let publicCards='';
  if(selected){
    const output=selected,preflight=state.sharePreflight[output.id],ready=!output.activePublished,mayCreate=can('viewer.shares.create')&&(!ready||can('viewer.processing.publish'));
    const blocked=Boolean(preflight?.error),views=availableShareViews(output),warning=preflight?.existingAccessUpdateRequired?'Activating this version can update existing model/client access and project links, and shows this task to every client who has the whole project. Confirmation is required before creating the link.':ready?'This model is private. Create public link publishes it, which also shows this task to every client who has the whole project.':'';
    const form=checking?empty('Checking share eligibility…'):mayCreate&&!blocked&&views.length?
      `<form class="manage-form share-dialog-form share-form" data-output-id="${esc(output.id)}">${field('Link label','label','maxlength="120"')}${field('Optional password','password','type="password" minlength="8" autocomplete="new-password"')}${field('Expiry (optional)','expiresAt','type="datetime-local"')}${shareViewControls(output)}<label class="check"><input type="checkbox" name="measure" checked> Temporary measurements (not saved to the project)</label><label class="check"><input type="checkbox" name="cameras" checked> Camera positions</label><label class="check"><input type="checkbox" name="download" checked> Downloads, including model report</label>${warning?`<p class="form-note share-warning">${esc(warning)}</p>`:''}<button class="primary-button">Create public link</button></form>`:
      blocked?empty('Sharing eligibility could not be verified. Close and reopen Share to retry.'):empty(mayCreate?'No verified views are available for this link.':'Creating a link requires share permission and, for private ready models, activation permission.');
    const list=can('viewer.shares.read')?`<div class="data-list top-gap">${(state.shares[output.id]||[]).map(share=>`<div class="manage-row"><div><strong>${esc(share.label||'Public link')}</strong><small>${esc(shareSettingsSummary(share))}</small></div>${badge(publicLinkState(share))}<div class="row-actions">${!share.revokedAt?`${button('copy-existing-share',share.id,'Copy link')}${button('open-existing-share',share.id,'Open')}${can('viewer.shares.create')?button('edit-share',share.id,'Edit settings'):''}${can('viewer.shares.revoke')?button('revoke-share',share.id,'Revoke'):''}`:''}</div></div>`).join('')||empty('No public links.')}</div>`:'';
    publicCards=card(output.displayName||'Model',form+list);
  }
  // A project and a task open the same dialog: the same two tabs, Client Workspace first and selected.
  const tab=(name,label)=>`<button type="button" class="segmented-tab" data-share-mode="${name}" role="tab" id="share-tab-${name}" aria-controls="share-panel-${name}" tabindex="${mode===name?0:-1}" aria-selected="${mode===name}">${label}</button>`;
  const publicPanel=onlyOutputId
    ?`${result}${publicCards}`
    :'<p class="form-note">A public link opens one task. Use Share on that task to create one.</p><div data-legacy-project-shares></div>';
  // A refresh of an open dialog replaces its content: keyboard focus on a tab or Close goes back to the same control.
  const active=document.activeElement,focusKey=!active||!modal.open||!modalContent.contains(active)?null:/^share-tab-/.test(active.id)?`#${active.id}`:active.classList.contains('modal-close')?'.modal-close':null;
  openModal(onlyOutputId?`Share task: ${task?.displayName||selected?.displayName||'Model'}`:`Share project: ${project?.displayName||'Project'}`,`<div class="segmented-tabs" role="tablist" aria-label="Sharing audience">${tab('internal','Client Workspace')}${tab('public',publicTabLabel(selected?state.shares[selected.id]:null))}</div><div class="share-columns" style="grid-template-columns:1fr" data-share-context="${esc(state.shareContext?.id||'')}"><div data-share-mode-panel="internal" role="tabpanel" id="share-panel-internal" aria-labelledby="share-tab-internal" ${mode==='internal'?'':'hidden'}><div data-client-share-panel>${clientSharePanel(selected,onlyOutputId)}</div></div><div data-share-mode-panel="public" role="tabpanel" id="share-panel-public" aria-labelledby="share-tab-public" ${mode==='public'?'':'hidden'}>${publicPanel}</div></div>`,'wide-modal');
  if(focusKey)modalContent.querySelector(focusKey)?.focus();
  bindShareModal(projectId,onlyOutputId);
}
function shareExpiryInput(value){
  if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function editShareModal(projectId,outputId,shareId){
  const output=state.outputs.find(item=>item.id===outputId),share=(state.shares[outputId]||[]).find(item=>item.id===shareId);
  if(!output||!share||share.revokedAt||!can('viewer.shares.read')||!can('viewer.shares.create'))return;
  openModal('Edit public link',`<form id="share-edit-form" class="manage-form share-dialog-form">${field('Link label','label',`maxlength="120" value="${esc(share.label||'')}"`)}<label><span>Password</span><select name="passwordAction"><option value="keep">Keep current password setting</option><option value="set">Set or replace password</option><option value="remove">Remove password</option></select></label><label data-password-input hidden><span>New password</span><input name="password" type="password" minlength="8" autocomplete="new-password" disabled></label>${field('Expiry (optional)','expiresAt',`type="datetime-local" value="${esc(shareExpiryInput(share.expiresAt))}"`)}${shareViewControls(output,share.allowedViews??null)}<label class="check"><input name="measure" type="checkbox" ${share.permissions?.measure?'checked':''}> Temporary measurements (not saved to the project)</label><label class="check"><input name="cameras" type="checkbox" ${share.permissions?.cameras?'checked':''}> Camera positions</label><label class="check"><input name="download" type="checkbox" ${share.permissions?.download?'checked':''}> Downloads, including model report</label><p class="form-note">The URL stays the same. Password and permission changes apply to existing sessions. Link version behavior stays unchanged.</p><button class="primary-button" type="submit">Save link settings</button><p role="status"></p></form>`,'wide-modal');
  const form=modalContent.querySelector('#share-edit-form');bindShareViewControls(form);
  const permissionsAtOpen={...share.permissions};
  form.elements.passwordAction.onchange=()=>{const setting=form.elements.passwordAction.value==='set';form.querySelector('[data-password-input]').hidden=!setting;form.elements.password.disabled=!setting;form.elements.password.required=setting;};
  form.onsubmit=async event=>{
    event.preventDefault();if(form.shareBusy||form.shareSaved||!form.isConnected||!modal.open)return;
    let fields=[];const status=form.querySelector('[role="status"]');
    try{
      if(!can('viewer.shares.read')||!can('viewer.shares.create'))throw new Error('Editing public links requires share permissions.');
      const body={label:form.elements.label.value,expiresAt:form.elements.expiresAt.value===shareExpiryInput(share.expiresAt)?share.expiresAt||null:form.elements.expiresAt.value?new Date(form.elements.expiresAt.value).toISOString():null};
      const permissions=Object.fromEntries(['measure','cameras','download']
        .filter(name=>form.elements[name].checked!==Boolean(permissionsAtOpen[name]))
        .map(name=>[name,form.elements[name].checked]));
      if(Object.keys(permissions).length)body.permissions={view:true,...permissions};
      if(form.shareViewsChanged)body.allowedViews=selectedShareViews(form);
      if(form.elements.passwordAction.value==='set'){if(form.elements.password.value.length<8)throw new Error('Use at least eight characters for the password.');body.password=form.elements.password.value}
      if(form.elements.passwordAction.value==='remove')body.password=null;
      const serialized=JSON.stringify(body);if(form.shareRequest?.serialized!==serialized)form.shareRequest={serialized,key:crypto.randomUUID()};
      form.shareBusy=true;fields=[...form.querySelectorAll('input,select,button')].map(element=>[element,element.disabled]);for(const [element] of fields)element.disabled=true;status.textContent='Saving link settings…';
      const result=await api(`/api/v1/processing/shares/${encodeURIComponent(share.id)}`,{method:'PATCH',body,headers:{'Idempotency-Key':form.shareRequest.key}});
      form.shareSaved=true;state.shares[outputId]=(state.shares[outputId]||[]).map(item=>item.id===share.id?result.share:item);toast('Link settings updated');
      if(form.isConnected&&modal.open){if(state.shareContext)state.shareContext.mode='public';shareModal(projectId,outputId)}
    }catch(error){if(form.isConnected)status.textContent=error.message}
    finally{form.shareBusy=false;if(!form.shareSaved&&form.isConnected)for(const [element,disabled] of fields)element.disabled=disabled}
  };
}
async function retrieveShareLink(element){
  if(element.disabled||!can('viewer.shares.read'))return;
  let popup=null;
  if(element.dataset.action==='open-existing-share'){popup=window.open('about:blank','_blank');if(popup)popup.opener=null;}
  element.disabled=true;
  try{
    const result=await api(`/api/v1/processing/shares/${encodeURIComponent(element.dataset.id)}/link`);
    if(!element.isConnected||!modal.open){popup?.close();return}
    const url=new URL(result.viewUrl,location.origin);if(!['https:','http:'].includes(url.protocol)||url.origin!==location.origin)throw new Error('The server returned an invalid share URL.');
    if(element.dataset.action==='open-existing-share'){
      if(popup){popup.location.replace(url.href);return}
      const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open public link';element.closest('.manage-row').append(link);toast('Pop-up blocked. Use the Open public link below.',true);return;
    }
    try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(url.href);toast('Link copied')}
    catch{
      if(!element.isConnected||!modal.open)return;
      const row=element.closest('.manage-row');let input=row.querySelector('[data-recovered-share-url]');if(!input){input=document.createElement('input');input.readOnly=true;input.dataset.recoveredShareUrl='';input.setAttribute('aria-label','Public link to copy');row.append(input)}input.value=url.href;input.focus();input.select();toast('Clipboard unavailable. Select and copy the displayed link.',true);
    }
  }catch(error){popup?.close();const unavailable=error.status===409&&/share_link_unavailable|original link cannot be recovered/i.test(error.message);toast(unavailable?'The original URL is not recoverable. The existing link has not been changed or revoked; create a separate link if needed.':error.message,true)}finally{element.disabled=false}
}
// One Share, as it was when the person pressed the button: the sign-in, the dialog and the exact model, task and project.
// Checked after every await, so nothing read for one is used, asked or sent for another.
function shareFence(form,output,projectId){
  const token=state.token,subject=state.adminSession?.subject,context=state.shareContext,known=state.tasks.some(task=>task.id===output.taskId);
  const sessionId=state.adminSession?.id,generation=publicationAuthorityGeneration;
  const authority=()=>publicationAuthorityLive()&&generation===publicationAuthorityGeneration
    &&state.token===token&&state.adminSession?.subject===subject&&state.adminSession?.id===sessionId;
  const dialog=()=>authority()&&state.shareContext===context&&modal.open&&form.isConnected;
  const task=()=>state.tasks.find(item=>item.id===output.taskId);
  const moved=()=>Boolean(dialog()&&task()&&task().projectId!==projectId);
  return {context,authority,dialog,moved,sameShare:()=>authority()&&state.shareContext===context&&modal.open,live:()=>dialog()&&can('viewer.shares.create')&&(output.activePublished||can('viewer.processing.publish'))
    &&state.outputs.some(item=>item.id===output.id&&item.taskId===output.taskId&&item.modelId===output.modelId)
    &&(known?task()?.projectId===projectId:true)};
}
// All three lists are read now, never taken from when the dialog opened. What cannot be read is unknown, not nobody.
async function publicationAudience(output,projectId){
  const token=state.token,session=state.adminSession,generation=publicationAuthorityGeneration;
  const unknown=()=>({clients:[],complete:false,text:publishAudienceText([],{complete:false})});
  const current=()=>publicationAuthorityLive()&&generation===publicationAuthorityGeneration&&state.token===token
    &&state.adminSession===session&&can('viewer.client_grants.manage');
  if(!current())return unknown();
  const lists=(value,...names)=>names.every(name=>Array.isArray(value?.[name]))?value:null;
  const controller=new AbortController();
  publicationReads.add(controller);
  const read=path=>api(path,{signal:controller.signal});
  let direct,legacy,native;
  try{
    [direct,legacy,native]=(await Promise.allSettled([loadDirectClientAccess(read,projectId),read('/api/v1/workspace/client-grants'),read('/api/v1/workspace/native-client-grants')]))
      .map(result=>result.status==='fulfilled'?result.value:null);
  }finally{publicationReads.delete(controller)}
  if(!current())return unknown();
  const older=lists(legacy,'projects','associations','grants'),connected=lists(native,'targets','grants');
  const complete=Boolean(can('viewer.client_grants.manage')&&direct&&!direct.grantsIncomplete&&older&&connected),clients=new Map();
  for(const client of direct?publishAudience(direct,{projectId,taskId:output.taskId}):[])clients.set(client.key,client);
  // Older Operations shares follow the model.
  const access=clientAccessSnapshot(older,connected),own=(access.associations||[]).filter(item=>output.modelId&&associationModelId(item)===output.modelId);
  const ids=new Set(own.map(item=>item.id)),projects=new Set(own.map(associationProjectId));
  for(const grant of access.grants||[]){
    if((grant.status||'active')!=='active')continue;
    if(!((grant.scopeType||grant.scope_type)==='task'?ids.has(grant.associationId||grant.association_id):projects.has(grant.projectId||grant.project_id)))continue;
    // A connected workspace is the same client as its direct share; an older account has no such link.
    const id=portalAccountId(grant)||grant.id,key=grant.native?JSON.stringify([grant.source_id,grant.workspace_id]):JSON.stringify(['account',id]);
    if(!clients.has(key))clients.set(key,{key,name:grant.clientName||grant.client_name||'a client',id});
  }
  const all=[...clients.values()];
  return {clients:all.map(client=>client.key).sort(),complete,text:publishAudienceText(publishAudienceNames(all),{complete})};
}
// Before a public link publishes a model: which clients gain the task, and what an existing version's links gain.
// Asked again if that grew while the question was open, so what is sent is what was answered.
async function confirmPublication(output,projectId,existingAccess,fence,answered=null){
  for(let round=0;round<4;round++){
    const audience=await publicationAudience(output,projectId);
    if(!fence.live())return false;
    const grew=answered&&(audience.clients.some(key=>!answered.clients.includes(key))||answered.complete&&!audience.complete||existingAccess&&!answered.existingAccess);
    if(answered?!grew:!existingAccess&&!audience.text)return {...audience,existingAccess};
    if(round===3)break;
    const asking=`${answered?'Client access changed while you were deciding. ':''}${audience.text}`;
    const controller=audience.clients.length&&fence.context?new AbortController():null;
    if(controller)fence.context.publicationConfirmation=controller;
    let agreed;
    try{
      const signal=controller?{signal:controller.signal}:{};
      agreed=existingAccess
        ?await dialogs.confirm(`${asking?`${asking} `:''}Activating this model version can change what existing model links, associated clients, and whole-project links can see. Whole-project links and clients who have the whole project also get newly activated tasks. Continue and create the public link?`,
          {title:'Update existing shared access?',submitLabel:'Activate and create link',...signal})
        :await dialogs.confirm(asking,{title:'Publish this task?',submitLabel:'Publish and create link',...signal});
    }finally{
      if(controller&&fence.context.publicationConfirmation===controller)delete fence.context.publicationConfirmation;
    }
    if(!agreed||!fence.live())return false;
    answered={...audience,existingAccess};
  }
  throw new Error('Client access keeps changing, so nothing was shared. Try again in a moment.');
}
// The task is in another project now, with other clients: nothing was shared, and Share opens again there.
async function reopenMovedShare(output,projectId,fence){
  const name=state.tasks.find(task=>task.id===output.taskId)?.displayName||'This task';
  let moved=null;
  try{const result=await api(`/api/v1/tasks/${encodeURIComponent(output.taskId)}`);if(result?.task?.id===output.taskId&&result.task.projectId!==projectId)moved=result.task;}catch{}
  if(!fence.dialog()){if(fence.authority())toast(`${name} moved to another project. Nothing was shared.`,true);return}
  if(!moved)return toast(`${name} moved to another project. Nothing was shared. Close Share and open it again.`,true);
  state.tasks=state.tasks.map(task=>task.id===moved.id?{...task,...moved}:task);
  state.outputs=state.outputs.map(item=>item.taskId===moved.id?{...item,projectId:moved.projectId}:item);
  toast(`${name} moved to ${state.projects.find(project=>project.id===moved.projectId)?.displayName||'another project'}. Nothing was shared. Check who will see it and create the link again.`,true);
  const opening=openShareModal(moved.projectId,output.id);
  if(state.shareContext)state.shareContext.mode='public';
  await opening;
}
async function createOutputShare(form,projectId,onlyOutputId){
  if(form.shareBusy||form.shareSaved||!onlyOutputId)return;
  form.shareBusy=true;
  const submit=form.querySelector('button[type="submit"],button:not([type])');
  let fields=[];
  if(submit)submit.disabled=true;
  try{
    const output=state.outputs.find(item=>item.id===form.dataset.outputId);
    if(!output||!can('viewer.shares.create')||(!output.activePublished&&!can('viewer.processing.publish')))throw new Error('Sharing is not permitted for this output.');
    const input=values(form);let body={label:input.label,expiresAt:input.expiresAt?new Date(input.expiresAt).toISOString():null,allowedViews:selectedShareViews(form),
      permissions:{view:true,measure:form.elements.measure.checked,cameras:form.elements.cameras.checked,download:form.elements.download.checked}};
    if(input.password)body.password=input.password;
    const inputSignature=JSON.stringify(body);
    fields=[...form.querySelectorAll('input,select,button')].map(element=>[element,element.disabled]);for(const [element] of fields)element.disabled=true;
    const fence=shareFence(form,output,projectId);
    const stopped=()=>fence.moved()?reopenMovedShare(output,projectId,fence):undefined;
    const path=`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/shares`;
    const pending=state.pendingOutputShares??=new Map();
    const sessionId=state.adminSession?.id;
    let request=pending.get(output.id),consent=null,result,receiptRecovered=false;
    if(request?.busy)return;
    if(request&&(request.subject!==state.adminSession?.subject||request.sessionId!==sessionId))
      throw new Error('A previous request is unresolved. Review the existing links before creating another.');

    const stillCurrent=()=>{
      if(!fence.live())throw Object.assign(new Error('The share dialog or its authorization changed.'),{code:'share_dispatch_cancelled'});
    };
    const dispatch=async(receiptOnly=false)=>{
      const sending=request;
      sending.busy=true;
      try{
        const outcome=await api(path,{
          method:'POST',body:JSON.parse(sending.serialized),
          headers:{'Idempotency-Key':sending.key,...(receiptOnly?{'X-Viewer-Share-Receipt-Only':'true'}:{})},
          beforeDispatch:async()=>{
            stillCurrent();
            if(!receiptOnly&&body.publishIfReady){
              consent=await confirmPublication(output,projectId,body.allowExistingAccessUpdate===true,fence,consent);
              if(!consent)throw Object.assign(new Error('Publication was not confirmed.'),{code:'share_dispatch_cancelled'});
            }
            const approvedSession=state.adminSession;
            return ()=>{
              stillCurrent();
              if(state.adminSession!==approvedSession)
                throw Object.assign(new Error('Workspace access changed. Review the share again.'),{code:'share_dispatch_cancelled'});
              if(!receiptOnly&&body.publishIfReady&&consent.clients.length&&!can('viewer.client_grants.manage'))
                throw Object.assign(new Error('Client access changed. Review the share again.'),{code:'share_dispatch_cancelled'});
              if(!receiptOnly)sending.dispatched=true;
            };
          },
        });
        if(typeof outcome?.share?.id!=='string'||!outcome.share.id.trim()||(receiptOnly&&!outcome.receiptReplayed))
          throw new Error('The link request outcome could not be read. Retry to check it.');
        return outcome;
      }finally{sending.busy=false}
    };
    const makeRequest=()=>({
      serialized:JSON.stringify(body),key:crypto.randomUUID(),inputSignature,sessionId,
      subject:state.adminSession?.subject,busy:false,dispatched:false,
    });
    if(request){
      try{result=await dispatch(true);receiptRecovered=true}catch(error){
        if(error.code==='idempotency_in_progress')
          throw new Error('The previous link request is still being processed. Try again to check it.');
        if(error.status!==404||error.code!=='share_receipt_missing'||error.receiptReplayed){
          if(error.code==='share_dispatch_cancelled')return await stopped();
          if(error.receiptRecorded&&error.status>=400&&error.status<500){
            pending.delete(output.id);
            if(error.status===409&&error.code==='output_project_changed')return await reopenMovedShare(output,projectId,fence);
            if(error.status===409&&error.code==='existing_access_update_confirmation_required')
              state.sharePreflight[output.id]={...state.sharePreflight[output.id],existingAccessUpdateRequired:true};
          }
          throw error;
        }
      }
      if(!result){
        if(request.inputSignature!==inputSignature){
          const retry=await dialogs.confirm('The previous request used different settings. Retry it with its original settings?',{
            title:'Retry previous link request?',submitLabel:'Retry previous request',
          });
          if(!retry||!fence.live())return await stopped();
        }
        body=JSON.parse(request.serialized);
      }
    }else{
      if(!output.activePublished){
        if(fence.moved())return await stopped();
        body.publishIfReady=true;body.expectedProjectId=projectId;
        if(state.sharePreflight[output.id]?.existingAccessUpdateRequired)body.allowExistingAccessUpdate=true;
      }
      request=makeRequest();
      pending.set(output.id,request);
    }
    if(!result){
      try{
        try{result=await dispatch()}catch(error){
          if(!error.receiptRecorded||error.status!==409||error.code!=='existing_access_update_confirmation_required'||body.allowExistingAccessUpdate)throw error;
          body.allowExistingAccessUpdate=true;
          request=makeRequest();
          pending.set(output.id,request);
          result=await dispatch();
        }
      }catch(error){
        if(!request.dispatched||error.receiptRecorded&&error.status>=400&&error.status<500)pending.delete(output.id);
        if(error.code==='share_dispatch_cancelled')return await stopped();
        if(error.receiptRecorded&&error.status===409&&error.code==='output_project_changed')return await reopenMovedShare(output,projectId,fence);
        if(error.code==='idempotency_in_progress')throw new Error('The previous link request is still being processed. Try again to check it.');
        throw error;
      }
    }
    pending.delete(output.id);
    if(!fence.authority())return;
    if(receiptRecovered||result.receiptReplayed){
      form.shareSaved=true;
      clearShareResult(result.share.id,'model');
      const changed=output.projectId||projectId;
      outputFences.set(changed,(outputFences.get(changed)||0)+1);
      toast('The previous link request completed. Check the current link in Share.');
      await refreshProjectOutputs(changed);
      if(fence.sameShare()&&!fence.moved()){
        const opening=openShareModal(projectId,onlyOutputId);
        if(state.shareContext)state.shareContext.mode='public';
        await opening;
      }
      return;
    }
    // The link exists: its model's rows are updated wherever the person is now. Only the dialog it was asked from shows it.
    const here=fence.sameShare();
    if(here){rememberShareResult(result,projectId,output.id);if(fence.context)fence.context.mode='public'}
    form.shareSaved=true;
    state.shares[output.id]=[result.share,...(state.shares[output.id]||[]).filter(share=>share.id!==result.share.id)];
    state.sharePreflight[output.id]={...state.sharePreflight[output.id],publicationRequired:false,existingAccessUpdateRequired:false,error:null};
    // Opening a published model needs the server's view address, and a list read while the link was
    // being made may have replaced these rows: complete the current row, then read the project again.
    for(const row of new Set([output,...state.outputs.filter(item=>item.id===output.id)])){
      row.activePublished=true;row.status='published';row.viewSessionUrl||=`/api/v1/processing/outputs/${encodeURIComponent(row.id)}/view-sessions`;
    }
    if(body.publishIfReady){
      const changed=output.projectId||projectId;outputFences.set(changed,(outputFences.get(changed)||0)+1);void refreshProjectOutputs(changed);
    }
    toast(here?'Public link created. Use Copy to share it.':`Public link created for ${state.tasks.find(task=>task.id===output.taskId)?.displayName||output.displayName||'the model'}. Open its Share to copy it.`);
    // Clipboard is a separate explicit action, never part of creation success.
    if(fence.dialog()){shareModal(projectId,onlyOutputId);if(!onlyOutputId)injectProjectShareCard(projectId)}
  }catch(error){toast(error.message,true)}
  finally{form.shareBusy=false;if(form.isConnected&&!form.shareSaved){for(const [element,disabled] of fields)element.disabled=disabled;if(submit)submit.disabled=false}}
}
function clientGrantRevocationMessage(result,native){
  if(native){
    const seconds=result?.existingSessionsExpireWithinSeconds;
    return Number.isSafeInteger(seconds)&&seconds>0&&seconds<=1800
      ?`New client access revoked. Open sessions may continue for up to ${Math.ceil(seconds/60)} minutes.`
      :'New client access revoked. Open sessions may continue until they expire.';
  }
  return result?.sessionRevocation?.pending
    ?'Client access revoked. Revocation of existing sessions is pending.'
    :'Client access revoked';
}
function bindShareModal(projectId,onlyOutputId,{preserveDirectForm=false}={}){
  modalContent.querySelectorAll('[data-share-mode]').forEach(element=>element.onclick=()=>{
    if(!state.shareContext)return;
    const mode=element.dataset.shareMode==='public'?'public':'internal';state.shareContext.mode=mode;
    modalContent.querySelectorAll('[data-share-mode]').forEach(button=>{button.setAttribute('aria-selected',String(button.dataset.shareMode===mode));button.tabIndex=button.dataset.shareMode===mode?0:-1});
    modalContent.querySelectorAll('[data-share-mode-panel]').forEach(panel=>panel.hidden=panel.dataset.shareModePanel!==mode);
  });
  const shareTabs=[...modalContent.querySelectorAll('[data-share-mode]')];
  shareTabs.forEach((tab,index)=>tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=shareTabs[event.key==='Home'?0:event.key==='End'?shareTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+shareTabs.length)%shareTabs.length];next.click();next.focus()});
  modalContent.querySelectorAll('.share-form').forEach(bindShareViewControls);
  modalContent.querySelectorAll('[data-action="copy-existing-share"],[data-action="open-existing-share"]').forEach(element=>element.onclick=()=>retrieveShareLink(element));
  modalContent.querySelectorAll('[data-action="edit-share"]').forEach(element=>element.onclick=()=>editShareModal(projectId,onlyOutputId,element.dataset.id));
  const directForm=modalContent.querySelector('#direct-client-grant-form');
  if(directForm&&!preserveDirectForm)bindDirectShare(directForm,projectId,onlyOutputId);
  modalContent.querySelectorAll('[data-action="revoke-direct-client-grant"]').forEach(element=>element.onclick=async()=>{
    // Pinned to this modal and row: a late answer must not touch a different Share dialog.
    const shareContext=state.shareContext,access=state.clientDirectAccess,live=()=>state.shareContext===shareContext&&state.clientDirectAccess===access&&element.isConnected&&modal.open;
    const grant=access?.grants.find(item=>item.grantId===element.dataset.id);if(!grant||element.disabled)return;
    const what=grant.scopeType==='project'?'the whole project':`the task “${state.tasks.find(task=>task.id===grant.taskId)?.displayName||'Unavailable task'}”`;
    const input=await dialogs.form({title:'Revoke client access',message:`${grant.clientDisplayName||'This client'} will lose access to ${what}.`,submitLabel:'Revoke access',destructive:true,fields:[{name:'reason',label:'Reason for revoking this client access',required:true,maxLength:240}]});
    if(!input||!live())return;element.disabled=true;
    try{
      const result=await api(`${DIRECT_CLIENT_GRANTS_PATH}/${encodeURIComponent(grant.grantId)}`,{method:'DELETE',body:{reason:input.reason}});
      toast(clientGrantRevocationMessage(result,false));
      if(!live())return;grant.revokedAt=new Date().toISOString();rerenderClientSharePanel(projectId,onlyOutputId);
    }catch(error){toast(directShareErrorText(error),true);if(element.isConnected)element.disabled=false}
  });
  const grantForm=modalContent.querySelector('#client-grant-form');
  if(grantForm){const portal=grantForm.elements.portalConnection,target=grantForm.elements.associationId||grantForm.elements.projectId;if(portal&&target){const update=()=>{for(const option of target.options){if(!option.value)continue;option.hidden=option.dataset.portal!==portal.value;option.disabled=option.hidden}target.value=''};portal.onchange=update;update()}}
  if(grantForm)grantForm.onsubmit=async event=>{
    event.preventDefault();if(grantForm.shareBusy)return;grantForm.shareBusy=true;
    try{
      const body=clientGrantBody(grantForm,onlyOutputId);
      if(!onlyOutputId&&!await dialogs.confirm('Grant access to the entire selected Operations project? This is broader than one Viewer model.',
        {title:'Whole-project client access',submitLabel:'Grant project access'}))return;
      if(!modal.open||!grantForm.isConnected)return;
      const serialized=JSON.stringify(body);
      if(grantForm.shareRequest?.serialized!==serialized)grantForm.shareRequest={serialized,key:crypto.randomUUID()};
      const result=await api(body.connection==='native'?'/api/v1/workspace/native-client-grants':'/api/v1/workspace/client-grants',{method:'POST',body,headers:{'Idempotency-Key':grantForm.shareRequest.key}});
      if(body.connection==='native')state.clientNativeAccess=result;else state.clientAccess=result;toast('Client access granted');
      if(modal.open&&grantForm.isConnected){shareModal(projectId,onlyOutputId);if(!onlyOutputId)injectProjectShareCard(projectId)}
    }catch(error){toast(error.message,true)}finally{grantForm.shareBusy=false}
  };
  modalContent.querySelectorAll('.share-form').forEach(form=>form.onsubmit=event=>{event.preventDefault();return createOutputShare(form,projectId,onlyOutputId)});
  modalContent.querySelectorAll('[data-action="revoke-client-grant"],[data-action="revoke-native-client-grant"]').forEach(element=>element.onclick=async()=>{const input=await dialogs.form({title:'Revoke client access',submitLabel:'Revoke access',destructive:true,fields:[{name:'reason',label:'Reason for revoking this client access',required:true,maxLength:240}]});if(input){modal.close();mutate(element.dataset.action==='revoke-native-client-grant'?'/api/v1/workspace/native-client-grants':'/api/v1/workspace/client-grants',{method:'DELETE',body:{grantId:element.dataset.id,reason:input.reason}},result=>clientGrantRevocationMessage(result,element.dataset.action==='revoke-native-client-grant'))}});
  modalContent.querySelectorAll('[data-action="revoke-share"]').forEach(element=>element.onclick=async()=>{
    if(!can('viewer.shares.revoke')||!await dialogs.confirm('Revoke this public link? Future access through this link will be blocked.',
      {title:'Revoke public link',submitLabel:'Revoke link',destructive:true})||!element.isConnected||!modal.open)return;
    modal.close();const revoked=await mutate(`/api/v1/processing/shares/${encodeURIComponent(element.dataset.id)}`,{method:'DELETE',body:{}},'Link revoked');
    if(revoked)clearShareResult(element.dataset.id,'model');
  });
  modalContent.querySelectorAll('[data-action="copy-share"]').forEach(element=>element.onclick=async()=>{
    try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(element.dataset.url);toast('Link copied')}
    catch{toast('The link is created, but clipboard access is unavailable. Select the link above and copy it manually.',true)}
  });
}
function bindModalActions(host=modalContent){if(!host)return;host.querySelectorAll('[data-action]').forEach(element=>element.onclick=async()=>{const action=element.dataset.action,id=element.dataset.id;if(action==='provider-new')return providerModal('__new__');if(action==='select-provider')return providerModal(id);if(action==='view-preset')return presetModal(state.selectedProviderId,id,'view');if(!can('viewer.providers.write'))return;if(action==='edit-provider')return editProviderModal(id);if(action==='replace-provider-token')return providerTokenModal(id);if(action==='clear-provider-token'){if(!await dialogs.confirm('Clear this node token and disable the provider?',{title:'Clear node token',submitLabel:'Clear token',destructive:true}))return;modal.close();await mutate(`/api/v1/processing/providers/${encodeURIComponent(id)}/credential`,{method:'DELETE',body:{}},'Provider token cleared');return providerModal(id)}if(action==='remove-provider'){const provider=state.providers.find(item=>item.id===id);if(!provider)return;const removed=await removeProcessingProvider({provider,confirm:(message,options)=>dialogs.confirm(message,options),mutate:(path,options,message)=>{modal.close();return mutate(path,options,message)}});return removed?providerModal(null):undefined}if(action==='new-preset')return presetModal(id);if(action==='import-preset')return importPresetModal(id);if(action==='duplicate-preset')return presetModal(state.selectedProviderId,id,'duplicate');if(action==='edit-preset'){const preset=state.presets.find(item=>item.id===id),provider=state.providers.find(item=>item.id===state.selectedProviderId&&item.type===preset?.providerType);return provider?presetModal(provider.id,id):toast('The preset no longer matches a current provider probe',true)}if(action==='delete-preset'){const preset=state.presets.find(item=>item.id===id),provider=state.providers.find(item=>item.id===state.selectedProviderId&&item.type===preset?.providerType);if(!provider||!await dialogs.confirm(`Delete preset "${preset.displayName}"?`,{title:'Delete preset',submitLabel:'Delete preset',destructive:true}))return;modal.close();await mutate(`/api/v1/processing/presets/${encodeURIComponent(id)}`,{method:'DELETE',body:{}},'Preset deleted');return providerModal(provider.id)}if(action==='probe-provider'){return refreshProviderCapabilities(id)}if(action==='toggle-provider'){modal.close();await mutate(`/api/v1/processing/providers/${encodeURIComponent(id)}`,{method:'PATCH',body:{enabled:element.dataset.enabled==='true'}},'Provider updated');return providerModal(id)}});const form=host.querySelector('#provider-form');if(form)form.onsubmit=async event=>{event.preventDefault();if(state.busy||!can('viewer.providers.write'))return;const input=values(form),submit=form.querySelector('button[type="submit"],button:not([type])'),body={displayName:input.displayName,endpoint:input.endpoint};if(input.token)body.credential={token:input.token};state.busy=true;submit.disabled=true;submit.textContent='Detecting…';try{const result=await api('/api/v1/processing/providers',{method:'POST',body});toast(`${providerName(result.detection?.providerType)} detected and added`);modal.close();await load();providerModal(result.provider.id)}catch(error){toast(error.message,true);submit.disabled=false;submit.textContent='Detect & add node'}finally{state.busy=false}}}

function logText(taskId){return(state.taskDetails[taskId]?.logs||[]).map(log=>`[${log.createdAt||''}] ${String(log.level||'info').toUpperCase()} ${log.message||''}`).join('\n')||'No task output has been recorded.'}
function downloadLogs(taskId){const task=state.tasks.find(item=>item.id===taskId),link=document.createElement('a');link.href=URL.createObjectURL(new Blob([logText(taskId)],{type:'text/plain'}));link.download=`${(task?.displayName||'task').replace(/[^a-z0-9_-]+/gi,'-')}-log-tail.txt`;link.click();URL.revokeObjectURL(link.href)}
function fullscreenLogs(taskId){openModal('Task output',`<pre class="log-tail fullscreen-log" tabindex="0">${esc(logText(taskId))}</pre>`,'wide-modal')}
async function digest(buffer){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(value=>value.toString(16).padStart(2,'0')).join('')}
function uploadFiles(form){return navigationWork.trackLegacyUpload(form.elements.files.files.length,()=>performLegacyUpload(form));}
async function performLegacyUpload(form){const files=[...form.elements.files.files],datasetId=form.elements.datasetId.value,role=form.elements.processingRole.value,total=files.reduce((sum,file)=>sum+file.size,0),progress=form.querySelector('progress');if(!files.length||files.length>128||files.some(file=>file.size>64*1024**2)||total>256*1024**2)return toast('Browser upload limit exceeded (128 files, 64 MB each, 256 MB total); use the server import folder for larger artifacts',true);state.busy=true;try{let preparedCount=0;const prepared=[];for(let index=0;index<files.length;index++){const buffer=await files[index].arrayBuffer();prepared.push({file:files[index],spec:{id:`file-${index}`,relativePath:files[index].webkitRelativePath||files[index].name,byteSize:files[index].size,sha256:await digest(buffer),contentType:files[index].type||'application/octet-stream',processingRole:role}});progress.value=Math.round(++preparedCount/files.length*15)}const created=await api(`/api/v1/datasets/${encodeURIComponent(datasetId)}/uploads`,{method:'POST',body:{files:prepared.map(item=>item.spec)}}),upload=created.upload,token=created.uploadToken;sessionStorage.setItem('ltds-viewer-upload',JSON.stringify({datasetId,uploadId:upload.id,manifest:prepared.map(item=>item.spec)}));let sent=0;for(const item of prepared){const remote=upload.files.find(file=>file.id===item.spec.id),missing=new Set(remote.missingChunks);for(let index=0;index<remote.chunkCount;index++){const start=index*upload.chunkSize,end=Math.min(start+upload.chunkSize,item.file.size);if(missing.has(index)){const chunk=await item.file.slice(start,end).arrayBuffer(),response=await workspaceFetch(`/api/v1/admin/uploads/${encodeURIComponent(upload.id)}/files/${encodeURIComponent(item.spec.id)}/chunks/${index}`,{method:'PUT',headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/octet-stream','X-Upload-Token':token,'X-Chunk-SHA256':await digest(chunk)},body:chunk});if(!response.ok)throw Error(`Chunk upload failed (${response.status})`)}sent+=end-start;progress.value=15+Math.round(sent/Math.max(total,1)*80)}}await api(`/api/v1/admin/uploads/${encodeURIComponent(upload.id)}/finalize`,{method:'POST',body:{uploadToken:token}});sessionStorage.removeItem('ltds-viewer-upload');progress.value=100;modal.close();toast('Upload finalized; processing will index the dataset');await load()}catch(error){toast(`${error.message}. Reselect the same files to resume.`,true)}finally{state.busy=false}}

async function pagedApi(path,key,options){const items=[],seen=new Set();let cursor=null;do{const separator=path.includes('?')?'&':'?',page=await api(`${path}${separator}limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,options);items.push(...(page[key]||[]));cursor=page.nextCursor||null;if(cursor&&seen.has(cursor))throw Error(`Pagination cursor repeated for ${key}`);if(cursor)seen.add(cursor)}while(cursor);return{[key]:items}}
async function pagedStorage(){let first=null,cursor=null;const items=[],seen=new Set();do{const page=await api(`/api/v1/storage?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);if(!first)first=page;items.push(...(page.trash?.items||[]));cursor=page.trash?.nextCursor||null;if(cursor&&seen.has(cursor))throw Error('Pagination cursor repeated for trash');if(cursor)seen.add(cursor)}while(cursor);return{...(first||{}),trash:{...(first?.trash||{}),items,nextCursor:null}}}
async function refreshTrash(){state.trashLoadError=null;render();try{state.storage=await pagedStorage()}catch(error){state.trashLoadError=error.message}render()}
async function load(){const generation=++projectDataGeneration, token=state.token, session=state.adminSession, fences=new Map(outputFences);
  workspaceLoads++;
  const current=()=>generation===projectDataGeneration&&token===state.token&&session===state.adminSession;
  try{const previousStorage=state.storage,requests=[pagedApi('/api/v1/projects','projects'),pagedApi('/api/v1/datasets','datasets'),pagedApi('/api/v1/tasks','tasks'),api('/api/v1/processing/providers?limit=100'),api('/api/v1/processing/presets'),pagedApi('/api/v1/processing/outputs','outputs'),pagedStorage(),can('viewer.storage.purge')?pagedApi('/api/v1/storage/mutations?status=failed','mutations'):Promise.resolve({mutations:[]}),api('/api/v1/processing/ready'),api('/api/v1/workspace/client-grants'),pagedApi('/api/v1/operations','operations'),pagedApi('/api/v1/processing/derivatives','derivatives'),api('/api/v1/diagnostics/runs?limit=20')],results=await Promise.allSettled(requests);if(!current())return;if(!state.token)return access();[state.projects,state.datasets,state.tasks,state.providers,state.presets,state.outputs,state.failedMutations,state.ready,state.clientAccess,state.operations,state.derivativeJobs]=[results[0].value?.projects||[],results[1].value?.datasets||[],results[2].value?.tasks||[],results[3].value?.providers||[],results[4].value?.presets||[],fencedOutputs(results[5].value?.outputs||[],fences),results[7].value?.mutations||[],results[8].value||null,results[9].value||null,results[10].value?.operations||[],results[11].value?.derivatives||[]];if(results[6].status==='fulfilled'){state.storage=results[6].value;state.trashLoadError=null}else{state.storage=previousStorage;state.trashLoadError=results[6].reason?.message||'Storage service unavailable'}if(results[12].status==='fulfilled'){state.diagnosticRuns=results[12].value?.runs||[];state.diagnosticRunsCursor=results[12].value?.nextCursor||null;state.diagnosticRunsError=null}else{state.diagnosticRunsError=results[12].reason?.message||'Processing run history is unavailable'}validateWorkspaceView();syncWorkspaceView('replace');const published=state.outputs.filter(output=>output.activePublished),sharesBefore={...state.shares},shareResults=await Promise.allSettled(published.map(output=>api(`/api/v1/processing/outputs/${encodeURIComponent(output.id)}/shares`)));if(!current())return;state.shares=currentShares(published,shareResults,sharesBefore);const okay=state.ready?.ok===true;setWorkspaceHealth({dot:document.querySelector('#nav-health-dot'),label:document.querySelector('#nav-health-label'),foot:document.querySelector('.workspace-nav-foot')},okay);render();hydrateExpandedTask();scheduleOperationRefresh()}finally{workspaceLoads--;scheduleProjectRefresh();}
}
function access(){content.innerHTML='<div class="auth-state"><div><p class="eyebrow">Secure workspace</p><h2>Open Viewer from Ledge Top Operations</h2><p>This workspace reuses your Operations identity and has no separate login.</p></div></div>'}

async function submitServerImport(form){if(state.busy)return;const submit=form.querySelector('button[type="submit"]'),browser=modalContent.querySelector('#server-import-browser');const endpoint=form.elements.sourceRelativePath.dataset.sourceKind==='zip'?'/api/v1/processing/webodm-task-imports':'/api/v1/processing/server-task-imports';state.busy=true;submit.disabled=true;submit.textContent='Starting import…';try{const result=await api(endpoint,{method:'POST',body:values(form),headers:{'Idempotency-Key':crypto.randomUUID()}});rememberOperation(result.operation);modal.close();toast('Import queued; progress will continue in Background work');scheduleOperationRefresh(500)}catch(error){browser.innerHTML=`<div class="empty-state">${esc(error.message)}</div>`;submit.disabled=false;submit.textContent='Try again';toast(error.message,true)}finally{state.busy=false}}
modalContent.addEventListener('submit',event=>{const form=event.target;if(form?.id!=='server-import-form')return;event.preventDefault();event.stopImmediatePropagation();submitServerImport(form)},true);

document.addEventListener('visibilitychange',()=>scheduleProjectRefresh(0));
content.addEventListener('dragstart',beginTaskDrag);
content.addEventListener('dragover',event=>{
  if(!draggedFolderTask)return;
  const target=taskDropTarget(event);
  setTreeDragHover(target?.element||null);
  if(!target){if(event.dataTransfer)event.dataTransfer.dropEffect='none';return;}
  event.preventDefault();
  event.dataTransfer.dropEffect='move';
});
// Near the top or bottom edge a drag scrolls the page; outside the tree nothing is highlighted.
document.addEventListener('dragover',event=>{
  if(!draggedFolderTask)return;
  if(!content.contains(event.target))setTreeDragHover(null);
  const top=(document.querySelector('.workspace-header')?.getBoundingClientRect().bottom||0)+48;
  if(event.clientY<top)window.scrollBy(0,-16);else if(event.clientY>innerHeight-48)window.scrollBy(0,16);
});
content.addEventListener('drop',event=>{
  const task=draggedFolderTask,target=taskDropTarget(event);
  if(!task||!target)return;
  event.preventDefault();
  clearTaskDrag();
  if(target.projectId===task.projectId)return void moveFolderTask(task,target.folderId,{});
  // Another project: straight through, unless the task is published (client access changes).
  void dropTaskOnProject(task,target.projectId,target.folderId);
});
content.addEventListener('dragend',()=>{
  if(!draggedFolderTask)return;
  clearTaskDrag();
  if(projectPaintPending)projectPaintPending=repaintOpenProjects();
});

installWorkspaceSidebar({shell,toggle:document.querySelector('#nav-toggle'),collapseButton:document.querySelector('#nav-collapse'),container:document.querySelector('#workspace-navigation'),rerender:renderNav});
document.querySelector('#background-work-button').onclick=()=>navigateWorkspace({section:'background'},'push');
document.querySelector('#refresh-button').onclick=()=>{storageUsagePoll.stop();return state.token?load():access()};
document.querySelector('#new-project-button').onclick=newProjectModal;
addEventListener('popstate',()=>{releaseAllGcpImages();applyWorkspaceView(readWorkspaceView());validateWorkspaceView();render();hydrateExpandedTask()});
try{const recovered=await resumeCurrentTabWorkspaceRecovery({accessToken:state.token,install:installWorkspaceSession,restoreView:view=>{if(view)applyWorkspaceView(view);syncWorkspaceView('replace');}});if(!recovered&&relayWorkspaceRecoveryGrant()){}else{const redeemed=recovered||await redeemGrant();if(!redeemed&&state.token)await restoreWorkspaceSession();if(state.token)await load();else{renderNav();access()}}}catch(error){if(error.fatal||error.status===401||!state.token)clearWorkspaceAuthorization('revoked');else{try{if(!workspaceRenewal)await restoreWorkspaceSession()}catch(currentError){if(currentError.status===401)clearWorkspaceAuthorization()}if(state.token){renderNav();toast('Viewer session renewal is temporarily unavailable; your current session was preserved',true);await load()}}}
