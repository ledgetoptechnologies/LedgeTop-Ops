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
const scopedKey=(item:{scope:Scope;kind:string;id:string})=>`${item.scope??''}\u0000${item.kind}:${item.id}`;
const allIncluded=(pages:PortalNotificationHistoryPage['coverage'][],pick:(coverage:PortalNotificationHistoryPage['coverage'])=>boolean)=>pages.length>0&&pages.every(pick);

/**
 * scopes: in the unified portal, every client account the person can open. Each
 * account is read and updated with its own explicit scope; without scopes the
 * bell follows the tab's current account exactly as before.
 */
export function PortalNotifications({scopes,labels}:{scopes?:string[];labels?:ReadonlyMap<string,string>}={}){
  const scopeList:Scope[]=scopes&&scopes.length?scopes:[null],scopeKey=scopeList.join('\u0000');
  const [open,setOpen]=useState(false),[items,setItems]=useState<ScopedItem[]>([]),[cursors,setCursors]=useState<Map<Scope,string>>(()=>new Map());
  const [coverages,setCoverages]=useState<Map<Scope,PortalNotificationHistoryPage['coverage']>>(()=>new Map());
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState<string[]>([]),root=useRef<HTMLDivElement>(null),generation=useRef(0),controller=useRef<AbortController|null>(null);
  const localUpdates=useRef(new Map<string,{dismissed?:boolean;readAt?:string}>());
  async function loadScope(scope:Scope,next:string|null,signal:AbortSignal,run:number):Promise<boolean>{
    try{const page=await requestJson<PortalNotificationHistoryPage>(`/api/client/notification-history${next?`?cursor=${encodeURIComponent(next)}`:''}`,{signal,...(scope?{workspaceId:scope}:{})});
      if(signal.aborted||run!==generation.current)return true;if(!validPage(page)||(scope!==null&&page.scope.workspaceId!==scope))throw new Error('Invalid notification history');
      const incoming=page.items.map(item=>({...item,scope}));
      setItems(current=>[...new Map([...(next?current:current.filter(item=>item.scope!==scope)),...incoming].map(item=>[scopedKey(item),item])).values()]
        .filter(item=>!localUpdates.current.get(scopedKey(item))?.dismissed)
        .map(item=>({...item,readAt:localUpdates.current.get(scopedKey(item))?.readAt??item.readAt}))
        .sort((left,right)=>right.createdAt.localeCompare(left.createdAt)));
      setCursors(current=>{const updated=new Map(current);if(page.nextCursor)updated.set(scope,page.nextCursor);else updated.delete(scope);return updated;});
      setCoverages(current=>new Map(current).set(scope,page.coverage));return true;
    }catch(caught){if(signal.aborted||run!==generation.current)return true;
      // A denied or changed account clears only its own items; other accounts stay.
      if([401,403,404,409,410].includes((caught as RequestError).status??0)){setItems(current=>current.filter(item=>item.scope!==scope));
        setCursors(current=>{const updated=new Map(current);updated.delete(scope);return updated;});}
      return false;}
  }
  async function load(more=false){if(controller.current)return;const abort=new AbortController(),run=generation.current;controller.current=abort;setLoading(true);setError('');
    try{const targets=more?scopeList.filter(scope=>cursors.has(scope)):scopeList;
      const results=await Promise.all(targets.map(scope=>loadScope(scope,more?cursors.get(scope)??null:null,abort.signal,run)));
      if(!abort.signal.aborted&&run===generation.current&&results.some(ok=>!ok))setError('Notifications could not be loaded. Your access may have changed.');}
    finally{if(controller.current===abort){controller.current=null;setLoading(false);}}
  }
  useEffect(()=>{generation.current++;controller.current?.abort();controller.current=null;localUpdates.current.clear();setItems([]);setCursors(new Map());setCoverages(new Map());setError('');void load();
    return()=>{generation.current++;controller.current?.abort();controller.current=null;};
    // scopeKey is the exact account list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scopeKey]);
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent|KeyboardEvent)=>{if(event instanceof KeyboardEvent&&event.key==='Escape'){setOpen(false);root.current?.querySelector<HTMLButtonElement>('button')?.focus();}
    else if(event instanceof MouseEvent&&root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close);};},[open]);
  async function mutate(item:ScopedItem,action:'read'|'dismiss'):Promise<boolean>{const itemKey=scopedKey(item),run=generation.current;if(busy.includes(itemKey))return false;setBusy(value=>[...value,itemKey]);
    try{await requestJson(item.mutationPath,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),...(item.scope?{workspaceId:item.scope}:{})});
      if(run!==generation.current)return false;
      localUpdates.current.set(itemKey,{...localUpdates.current.get(itemKey),...(action==='dismiss'?{dismissed:true}:{readAt:item.readAt??new Date().toISOString()})});
      setItems(value=>action==='dismiss'?value.filter(row=>scopedKey(row)!==itemKey):value.map(row=>scopedKey(row)===itemKey?{...row,readAt:row.readAt??new Date().toISOString()}:row));
      return true;
    }catch{if(run===generation.current)setError('The notification update could not be confirmed. Try again.');return false;}finally{if(run===generation.current)setBusy(value=>value.filter(id=>id!==itemKey));}}
  const unread=items.filter(item=>!item.readAt).length,hasMore=cursors.size>0,coverageList=[...coverages.values()];
  const requestsShown=allIncluded(coverageList,coverage=>coverage.requests==='included'),feedbackShown=allIncluded(coverageList,coverage=>coverage.feedback==='included');
  const deliveryValues=new Set(coverageList.map(coverage=>coverage.delivery)),delivery=deliveryValues.size===1?coverageList[0]?.delivery:undefined;
  const authenticatedShown=allIncluded(coverageList,coverage=>coverage.authenticatedDelivery==='included');
  return <div className="portal-notification-center" ref={root}><button className="portal-notification-bell" aria-label={`Notifications${unread?`, ${unread} unread update${unread===1?'':'s'}`:''}`} aria-expanded={open} aria-controls="portal-notification-panel" onClick={()=>setOpen(value=>!value)}><span aria-hidden="true">🔔</span>{unread>0&&<span className="portal-notification-count">{unread>99?'99+':unread}</span>}</button>
    {open&&<section id="portal-notification-panel" className="portal-notification-panel" aria-label="Notifications"><header><strong>Notifications</strong><button className="button-ghost button-small" onClick={()=>setOpen(false)} aria-label="Close notifications">Close</button></header>
      {loading&&<Skeleton variant="list" rows={3} label="Loading notifications…" />}{error&&<div role="alert"><p>{error}</p><button className="button-ghost button-small" onClick={()=>void load(hasMore&&items.length>0)}>Retry notifications</button></div>}
      {!loading&&!error&&!items.length&&<p className="portal-notification-empty">{hasMore?'Continue to check more updates.':'You’re all caught up.'}</p>}
      <div className="portal-notification-list">{items.map(item=>{const actionPath=safeFeedbackTargetPath(item.actionPath),key=scopedKey(item),label=item.scope?labels?.get(item.scope):undefined;return <article key={key} className={item.readAt?'':'is-unread'}>
        {actionPath?<a href={actionPath} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();const run=generation.current;void mutate(item,'read').then(updated=>{if(updated&&run===generation.current)window.location.assign(actionPath);});}}><strong>{item.title}</strong></a>:<strong>{item.title}</strong>}
        <p>{item.body}</p><small>{label?`${label} · `:''}{item.kind==='feedback'?'Feedback':item.kind==='delivery'||item.kind==='authenticated_delivery'?'Delivery':'Request'} · {new Date(item.createdAt).toLocaleString()}</small><div>{!item.readAt&&<button className="button-ghost button-small" disabled={busy.includes(key)} onClick={()=>void mutate(item,'read')}>Mark read</button>}
          <button className="button-ghost button-small" disabled={busy.includes(key)} onClick={()=>void mutate(item,'dismiss')}>Dismiss</button></div></article>;})}</div>
      {hasMore&&<button className="button-ghost button-small" disabled={loading} onClick={()=>void load(true)}>Load more updates</button>}
      <p className="portal-notification-coverage"><small>{requestsShown?'Request history is shown.':'Request history is currently unavailable.'} {feedbackShown?'Feedback history is shown.':'Feedback history is currently unavailable.'} {delivery==='included_legacy_portal_notices'?'Authorized portal delivery notices are shown.':delivery==='included_project_alpha_grant_notices'?'Authorized Project Alpha grant notices are shown as a separate stream from authenticated delivery file changes.':delivery==='omitted_schema_unavailable'?'Project Alpha grant notice history is currently unavailable.':'Staged delivery mail remains in its explicitly authorized delivery workflow.'} {authenticatedShown?'Authenticated delivery file-change history is shown.':'Authenticated delivery file-change history is currently unavailable.'}</small></p>
    </section>}
  </div>;
}
