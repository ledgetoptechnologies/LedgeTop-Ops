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

export function PortalNotifications(){
  const enabled=true,[open,setOpen]=useState(false),[items,setItems]=useState<PortalNotificationHistoryItem[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [coverage,setCoverage]=useState<PortalNotificationHistoryPage['coverage']|null>(null);
  const [loading,setLoading]=useState(enabled),[error,setError]=useState(''),[busy,setBusy]=useState<string[]>([]),root=useRef<HTMLDivElement>(null),generation=useRef(0),controller=useRef<AbortController|null>(null);
  const localUpdates=useRef(new Map<string,{dismissed?:boolean;readAt?:string}>());
  async function load(next:string|null=null){if(controller.current)return;const abort=new AbortController(),run=generation.current;controller.current=abort;setLoading(true);setError('');
    try{const page=await requestJson<PortalNotificationHistoryPage>(`/api/client/notification-history${next?`?cursor=${encodeURIComponent(next)}`:''}`,{signal:abort.signal});
      if(abort.signal.aborted||run!==generation.current)return;if(!validPage(page))throw new Error('Invalid notification history');
      setItems(current=>[...new Map((next?[...current,...page.items]:page.items).map(item=>[`${item.kind}:${item.id}`,item])).values()]
        .filter(item=>!localUpdates.current.get(`${item.kind}:${item.id}`)?.dismissed)
        .map(item=>({...item,readAt:localUpdates.current.get(`${item.kind}:${item.id}`)?.readAt??item.readAt})));setCursor(page.nextCursor);setCoverage(page.coverage);
    }catch(caught){if(abort.signal.aborted||run!==generation.current)return;if([401,403,404,409,410].includes((caught as RequestError).status??0)){setItems([]);setCursor(null);}
      setError('Notifications could not be loaded. Your workspace access may have changed.');}
    finally{if(controller.current===abort){controller.current=null;setLoading(false);}}
  }
  useEffect(()=>{generation.current++;controller.current?.abort();controller.current=null;localUpdates.current.clear();setItems([]);setCursor(null);setCoverage(null);setError('');if(enabled)void load();else setLoading(false);
    return()=>{generation.current++;controller.current?.abort();controller.current=null;};},[enabled]);
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent|KeyboardEvent)=>{if(event instanceof KeyboardEvent&&event.key==='Escape'){setOpen(false);root.current?.querySelector<HTMLButtonElement>('button')?.focus();}
    else if(event instanceof MouseEvent&&root.current&&!root.current.contains(event.target as Node))setOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close);};},[open]);
  async function mutate(item:PortalNotificationHistoryItem,action:'read'|'dismiss'):Promise<boolean>{const itemKey=`${item.kind}:${item.id}`,run=generation.current;if(busy.includes(itemKey))return false;setBusy(value=>[...value,itemKey]);
    try{await requestJson(item.mutationPath,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
      if(run!==generation.current)return false;
      localUpdates.current.set(itemKey,{...localUpdates.current.get(itemKey),...(action==='dismiss'?{dismissed:true}:{readAt:item.readAt??new Date().toISOString()})});
      setItems(value=>action==='dismiss'?value.filter(row=>`${row.kind}:${row.id}`!==itemKey):value.map(row=>`${row.kind}:${row.id}`===itemKey?{...row,readAt:row.readAt??new Date().toISOString()}:row));
      return true;
    }catch{if(run===generation.current)setError('The notification update could not be confirmed. Try again.');return false;}finally{if(run===generation.current)setBusy(value=>value.filter(id=>id!==itemKey));}}
  const unread=items.filter(item=>!item.readAt).length;
  return <div className="portal-notification-center" ref={root}><button className="portal-notification-bell" aria-label={`Notifications${unread?`, ${unread} unread update${unread===1?'':'s'}`:''}`} aria-expanded={open} aria-controls="portal-notification-panel" onClick={()=>setOpen(value=>!value)}><span aria-hidden="true">🔔</span>{unread>0&&<span className="portal-notification-count">{unread>99?'99+':unread}</span>}</button>
    {open&&<section id="portal-notification-panel" className="portal-notification-panel" aria-label="Notifications"><header><strong>Notifications</strong><button className="button-ghost button-small" onClick={()=>setOpen(false)} aria-label="Close notifications">Close</button></header>
      {loading&&<p role="status">Loading notifications…</p>}{error&&<div role="alert"><p>{error}</p><button className="button-ghost button-small" onClick={()=>void load(cursor)}>Retry notifications</button></div>}
      {!loading&&!error&&!items.length&&<p className="portal-notification-empty">{cursor?'Continue to check more updates.':'You’re all caught up.'}</p>}
      <div className="portal-notification-list">{items.map(item=>{const actionPath=safeFeedbackTargetPath(item.actionPath);return <article key={`${item.kind}:${item.id}`} className={item.readAt?'':'is-unread'}>
        {actionPath?<a href={actionPath} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();const run=generation.current;void mutate(item,'read').then(updated=>{if(updated&&run===generation.current)window.location.assign(actionPath);});}}><strong>{item.title}</strong></a>:<strong>{item.title}</strong>}
        <p>{item.body}</p><small>{item.kind==='feedback'?'Feedback':item.kind==='delivery'||item.kind==='authenticated_delivery'?'Delivery':'Request'} · {new Date(item.createdAt).toLocaleString()}</small><div>{!item.readAt&&<button className="button-ghost button-small" disabled={busy.includes(`${item.kind}:${item.id}`)} onClick={()=>void mutate(item,'read')}>Mark read</button>}
          <button className="button-ghost button-small" disabled={busy.includes(`${item.kind}:${item.id}`)} onClick={()=>void mutate(item,'dismiss')}>Dismiss</button></div></article>;})}</div>
      {cursor&&<button className="button-ghost button-small" disabled={loading} onClick={()=>void load(cursor)}>Load more updates</button>}
      <p className="portal-notification-coverage"><small>{coverage?.requests==='included'?'Request history is shown.':'Request history is currently unavailable.'} {coverage?.feedback==='included'?'Feedback history is shown.':'Feedback history is currently unavailable.'} {coverage?.delivery==='included_legacy_portal_notices'?'Authorized portal delivery notices are shown.':coverage?.delivery==='included_project_alpha_grant_notices'?'Authorized Project Alpha grant notices are shown as a separate stream from authenticated delivery file changes.':coverage?.delivery==='omitted_schema_unavailable'?'Project Alpha grant notice history is currently unavailable.':'Staged delivery mail remains in its explicitly authorized delivery workflow.'} {coverage?.authenticatedDelivery==='included'?'Authenticated delivery file-change history is shown.':'Authenticated delivery file-change history is currently unavailable.'}</small></p>
    </section>}
  </div>;
}
