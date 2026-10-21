import { Skeleton } from "@ltds/ui";
import {useEffect,useRef,useState} from 'react';
import type {PortalNotificationHistoryItem,PortalNotificationHistoryPage} from '@ltds/shared';
import {requestJson,type RequestError} from './bulk-download';
import {safeFeedbackTargetPath} from './feedback-api';

const validPath=(value:string|null)=>value===null||safeFeedbackTargetPath(value)!==null;
const authenticatedDeliveryMutation=/^\/api\/client\/notification-history\/authenticated-delivery\/[A-Za-z0-9_-]+$/;
function validAuthenticatedDeliveryPath(value:string|null,workspaceId:string|null){const path=safeFeedbackTargetPath(value);if(!path||!workspaceId)return false;const target=new URL(path,window.location.origin);
  return target.pathname==='/portal/deliveries'&&target.hash===''&&target.searchParams.size===2&&target.searchParams.getAll('workspace').length===1
    &&target.searchParams.get('workspace')===workspaceId&&target.searchParams.getAll('folder').length===1&&/^(?:np1|ad1)_[A-Za-z0-9_-]{1,8192}$/.test(target.searchParams.get('folder')??'');}
const validAuthenticatedDeliveryMutation=(value:string,id:string)=>/^[A-Za-z0-9_-]+$/.test(id)&&authenticatedDeliveryMutation.test(value)
  &&value===`/api/client/notification-history/authenticated-delivery/${id}`;
const validMutation=(value:string)=>value.startsWith('/api/client/notifications/')||value.startsWith('/api/client/feedback-notifications/')||
  /^\/api\/client\/v2\/workspaces\/[A-Za-z0-9_-]+\/(?:feedback-notifications|native-delivery-notifications)\/[A-Za-z0-9_-]+$/.test(value)||
  authenticatedDeliveryMutation.test(value);
const validLedger=(value:string)=>['included','omitted_feature_disabled','omitted_schema_unavailable'].includes(value);
function validPage(value:PortalNotificationHistoryPage){return value&&typeof value.scope?.sourceId==='string'&&typeof value.scope?.rootType==='string'&&typeof value.scope?.rootPublicId==='string'
  &&(value.scope.workspaceId===null||typeof value.scope.workspaceId==='string')&&validLedger(value.coverage?.requests)&&validLedger(value.coverage?.feedback)
  &&validLedger(value.coverage?.authenticatedDelivery)
  &&['included_legacy_portal_notices','included_project_alpha_grant_notices','omitted_no_explicit_grant_authority','omitted_schema_unavailable'].includes(value.coverage?.delivery)&&Array.isArray(value.items)&&value.items.every(item=>
    item&&['request','feedback','delivery','authenticated_delivery'].includes(item.kind)&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.body==='string'
    &&validPath(item.actionPath)&&validMutation(item.mutationPath)&&Number.isFinite(Date.parse(item.createdAt))&&(item.readAt===null||Number.isFinite(Date.parse(item.readAt)))
    &&(item.kind!=='authenticated_delivery'||value.coverage.authenticatedDelivery==='included'&&item.title==='Files changed in your delivery'&&(item.actionPath===null||validAuthenticatedDeliveryPath(item.actionPath,value.scope.workspaceId))&&validAuthenticatedDeliveryMutation(item.mutationPath,item.id)))
  &&(value.nextCursor===null||typeof value.nextCursor==='string'&&value.nextCursor.length>0);}

type Scope=string|null;
type ScopedItem=PortalNotificationHistoryItem&{scope:Scope};
type Coverage=PortalNotificationHistoryPage['coverage'];
const scopedKey=(item:{scope:Scope;kind:string;id:string})=>`${item.scope??''}\u0000${item.kind}:${item.id}`;
/** A definite refusal or changed context: that account's updates must not stay visible. */
const denied=(caught:unknown)=>[401,403,404,409,410].includes((caught as RequestError|null)?.status??0);
const REVALIDATE_MS=60_000;

/**
 * scopes: in the unified portal, every client account the person can open. Each
 * account is read and updated with its own explicit scope, keeps its own cursor and
 * status, and is retried on its own; without scopes the bell follows the tab's
 * current account exactly as before. contextKey is the verified portal context;
 * a change resets the bell. The bell revalidates on focus, when the tab becomes
 * visible again and every minute while visible.
 */
export function PortalNotifications({scopes,labels,contextKey=''}:{scopes?:string[];labels?:ReadonlyMap<string,string>;contextKey?:string}={}){
  const scopeList:Scope[]=scopes&&scopes.length?scopes:[null],scopeKey=`${contextKey}\u0001${scopeList.join('\u0000')}`;
  const [open,setOpen]=useState(false),[items,setItems]=useState<ScopedItem[]>([]),[cursors,setCursors]=useState<Map<Scope,string>>(()=>new Map());
  const [coverages,setCoverages]=useState<Map<Scope,Coverage>>(()=>new Map()),[failed,setFailed]=useState<ReadonlySet<Scope>>(()=>new Set());
  const [loadingScopes,setLoadingScopes]=useState<ReadonlySet<Scope>>(()=>new Set(scopeList)),[error,setError]=useState(''),[busy,setBusy]=useState<string[]>([]);
  const root=useRef<HTMLDivElement>(null),generation=useRef(0);
  // Per account: the latest load sequence (older replies are ignored), its abort
  // controller, and an epoch bumped whenever that account's access is withdrawn so
  // pending read/dismiss results and navigations for it are dropped.
  const sequences=useRef(new Map<Scope,number>()),controllers=useRef(new Map<Scope,AbortController>()),epochs=useRef(new Map<Scope,number>());
  const localUpdates=useRef(new Map<string,{dismissed?:boolean;readAt?:string}>()),cursorRef=useRef(cursors);cursorRef.current=cursors;
  const setIn=<T,>(update:(current:Set<T>)=>void)=>(current:ReadonlySet<T>)=>{const next=new Set(current);update(next);return next;};
  function withdraw(scope:Scope){epochs.current.set(scope,(epochs.current.get(scope)??0)+1);
    setItems(current=>current.filter(item=>item.scope!==scope));setBusy(current=>current.filter(key=>!key.startsWith(`${scope??''}\u0000`)));
    setCursors(current=>{const updated=new Map(current);updated.delete(scope);return updated;});
    setCoverages(current=>{const updated=new Map(current);updated.delete(scope);return updated;});}
  async function loadScope(scope:Scope,next:string|null){const run=generation.current,sequence=(sequences.current.get(scope)??0)+1;sequences.current.set(scope,sequence);
    controllers.current.get(scope)?.abort();const abort=new AbortController();controllers.current.set(scope,abort);
    const current=()=>run===generation.current&&sequences.current.get(scope)===sequence&&!abort.signal.aborted;
    setLoadingScopes(setIn(set=>set.add(scope)));
    try{const page=await requestJson<PortalNotificationHistoryPage>(`/api/client/notification-history${next?`?cursor=${encodeURIComponent(next)}`:''}`,{signal:abort.signal,...(scope?{workspaceId:scope}:{})});
      if(!current())return;if(!validPage(page)||(scope!==null&&page.scope.workspaceId!==scope))throw new Error('Invalid notification history');
      const incoming=page.items.map(item=>({...item,scope}));
      setItems(existing=>[...new Map([...(next?existing:existing.filter(item=>item.scope!==scope)),...incoming].map(item=>[scopedKey(item),item])).values()]
        .filter(item=>!localUpdates.current.get(scopedKey(item))?.dismissed)
        .map(item=>({...item,readAt:localUpdates.current.get(scopedKey(item))?.readAt??item.readAt}))
        .sort((left,right)=>right.createdAt.localeCompare(left.createdAt)));
      setCursors(existing=>{const updated=new Map(existing);if(page.nextCursor)updated.set(scope,page.nextCursor);else updated.delete(scope);return updated;});
      setCoverages(existing=>new Map(existing).set(scope,page.coverage));setFailed(setIn(set=>set.delete(scope)));
    }catch(caught){if(!current())return;
      // A denied or changed account clears only its own updates; other accounts stay.
      if(denied(caught))withdraw(scope);
      setFailed(setIn(set=>set.add(scope)));
    }finally{if(sequences.current.get(scope)===sequence&&run===generation.current){controllers.current.delete(scope);setLoadingScopes(setIn(set=>set.delete(scope)));}}
  }
  /** First page of the given accounts (all by default); each account settles on its own. */
  const reload=(targets:Scope[]=scopeList)=>{for(const scope of targets)void loadScope(scope,null);};
  const loadMore=()=>{for(const scope of scopeList){const cursor=cursorRef.current.get(scope);if(cursor&&!controllers.current.has(scope))void loadScope(scope,cursor);}};
  useEffect(()=>{generation.current++;for(const abort of controllers.current.values())abort.abort();controllers.current.clear();sequences.current.clear();epochs.current.clear();
    localUpdates.current.clear();setItems([]);setCursors(new Map());setCoverages(new Map());setFailed(new Set());setLoadingScopes(new Set());setBusy([]);setError('');reload();
    let lastStartedAt=Date.now();
    const revalidate=()=>{if(document.visibilityState!=='visible'||Date.now()-lastStartedAt<1000)return;lastStartedAt=Date.now();reload();};
    const onVisibility=()=>{if(document.visibilityState==='visible')revalidate();};
    window.addEventListener('focus',revalidate);document.addEventListener('visibilitychange',onVisibility);const timer=window.setInterval(revalidate,REVALIDATE_MS);
    return()=>{generation.current++;for(const abort of controllers.current.values())abort.abort();controllers.current.clear();
      window.removeEventListener('focus',revalidate);document.removeEventListener('visibilitychange',onVisibility);window.clearInterval(timer);};
    // scopeKey is the exact verified context and account list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scopeKey]);
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent|KeyboardEvent)=>{if(event instanceof KeyboardEvent&&event.key==='Escape'){setOpen(false);root.current?.querySelector<HTMLButtonElement>('button')?.focus();}
    else if(event instanceof MouseEvent&&root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close);};},[open]);
  async function mutate(item:ScopedItem,action:'read'|'dismiss'):Promise<boolean>{const itemKey=scopedKey(item),run=generation.current,epoch=epochs.current.get(item.scope)??0;if(busy.includes(itemKey))return false;setBusy(value=>[...value,itemKey]);
    const stillValid=()=>run===generation.current&&(epochs.current.get(item.scope)??0)===epoch;
    try{await requestJson(item.mutationPath,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),...(item.scope?{workspaceId:item.scope}:{})});
      if(!stillValid())return false;
      localUpdates.current.set(itemKey,{...localUpdates.current.get(itemKey),...(action==='dismiss'?{dismissed:true}:{readAt:item.readAt??new Date().toISOString()})});
      setItems(value=>action==='dismiss'?value.filter(row=>scopedKey(row)!==itemKey):value.map(row=>scopedKey(row)===itemKey?{...row,readAt:row.readAt??new Date().toISOString()}:row));
      return true;
    }catch(caught){if(!stillValid())return false;
      // Access to this account was withdrawn: drop its updates and pending actions now, then recheck it.
      if(denied(caught)){withdraw(item.scope);setFailed(setIn(set=>set.add(item.scope)));void loadScope(item.scope,null);setError('That account’s updates are no longer available.');}
      else setError('The notification update could not be confirmed. Try again.');return false;}
    finally{if(stillValid())setBusy(value=>value.filter(id=>id!==itemKey));}}
  const unread=items.filter(item=>!item.readAt).length,hasMore=cursors.size>0,loading=loadingScopes.size>0,failedList=scopeList.filter(scope=>failed.has(scope));
  // Coverage is shown only when every requested account reported it.
  const coverageList=scopeList.map(scope=>coverages.get(scope)),complete=coverageList.every(Boolean);
  const allIncluded=(pick:(coverage:Coverage)=>boolean)=>complete&&coverageList.every(coverage=>pick(coverage!));
  const requestsShown=allIncluded(coverage=>coverage.requests==='included'),feedbackShown=allIncluded(coverage=>coverage.feedback==='included');
  const deliveryValues=new Set(coverageList.map(coverage=>coverage?.delivery)),delivery=complete&&deliveryValues.size===1?coverageList[0]?.delivery:undefined;
  const authenticatedShown=allIncluded(coverage=>coverage.authenticatedDelivery==='included');
  const failedLabel=failedList.length===scopeList.length||!labels?'':` for ${failedList.map(scope=>scope&&labels.get(scope)||'an account').join(', ')}`;
  return <div className="portal-notification-center" ref={root}><button className="portal-notification-bell" aria-label={`Notifications${unread?`, ${unread} unread update${unread===1?'':'s'}`:''}`} aria-expanded={open} aria-controls="portal-notification-panel" onClick={()=>setOpen(value=>!value)}><span aria-hidden="true">🔔</span>{unread>0&&<span className="portal-notification-count">{unread>99?'99+':unread}</span>}</button>
    {open&&<section id="portal-notification-panel" className="portal-notification-panel" aria-label="Notifications"><header><strong>Notifications</strong><button className="button-ghost button-small" onClick={()=>setOpen(false)} aria-label="Close notifications">Close</button></header>
      {loading&&!items.length&&<Skeleton variant="list" rows={3} label="Loading notifications…" />}
      {failedList.length>0&&<div role="alert"><p>Notifications{failedLabel} could not be loaded. Your access may have changed.</p><button className="button-ghost button-small" disabled={failedList.every(scope=>loadingScopes.has(scope))} onClick={()=>{setError('');reload(failedList);}}>Retry notifications</button></div>}
      {error&&<p role="alert">{error}</p>}
      {!loading&&!failedList.length&&!items.length&&<p className="portal-notification-empty">{hasMore?'Continue to check more updates.':'You’re all caught up.'}</p>}
      <div className="portal-notification-list">{items.map(item=>{const actionPath=safeFeedbackTargetPath(item.actionPath),key=scopedKey(item),label=item.scope?labels?.get(item.scope):undefined;return <article key={key} className={item.readAt?'':'is-unread'}>
        {actionPath?<a href={actionPath} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();void mutate(item,'read').then(updated=>{if(updated)window.location.assign(actionPath);});}}><strong>{item.title}</strong></a>:<strong>{item.title}</strong>}
        <p>{item.body}</p><small>{label?`${label} · `:''}{item.kind==='feedback'?'Feedback':item.kind==='delivery'||item.kind==='authenticated_delivery'?'Delivery':'Request'} · {new Date(item.createdAt).toLocaleString()}</small><div>{!item.readAt&&<button className="button-ghost button-small" disabled={busy.includes(key)} onClick={()=>void mutate(item,'read')}>Mark read</button>}
          <button className="button-ghost button-small" disabled={busy.includes(key)} onClick={()=>void mutate(item,'dismiss')}>Dismiss</button></div></article>;})}</div>
      {hasMore&&<button className="button-ghost button-small" disabled={scopeList.every(scope=>!cursors.has(scope)||loadingScopes.has(scope))} onClick={loadMore}>Load more updates</button>}
      <p className="portal-notification-coverage"><small>{requestsShown?'Request history is shown.':'Request history is currently unavailable.'} {feedbackShown?'Feedback history is shown.':'Feedback history is currently unavailable.'} {delivery==='included_legacy_portal_notices'?'Authorized portal delivery notices are shown.':delivery==='included_project_alpha_grant_notices'?'Authorized Project Alpha grant notices are shown as a separate stream from authenticated delivery file changes.':delivery==='omitted_schema_unavailable'?'Project Alpha grant notice history is currently unavailable.':'Staged delivery mail remains in its explicitly authorized delivery workflow.'} {authenticatedShown?'Authenticated delivery file-change history is shown.':'Authenticated delivery file-change history is currently unavailable.'}</small></p>
    </section>}
  </div>;
}
