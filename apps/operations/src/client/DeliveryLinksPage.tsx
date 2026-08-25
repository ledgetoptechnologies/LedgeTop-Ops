import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api } from "./api";
import { deliveryPathFromPrefix } from "./delivery-route";

interface DeliveryShareHistoryRow {
  id:string;
  label:string|null;
  client_name:string;
  project_name:string;
  target_path:string;
  target_kind:"folder"|"file";
  display_name:string;
  created_at:string;
  expires_at:string|null;
  revoked_at:string|null;
  unavailable_since:string|null;
  password_protected:number|boolean;
  access_count:number;
  last_accessed_at:string|null;
}

interface DeliveryShareHistoryResponse {
  shares:DeliveryShareHistoryRow[];
  nextCursor:string|null;
}

function shownDate(value:string|null):string{
  if(!value)return"Never";
  const parsed=new Date(value);
  return Number.isNaN(parsed.valueOf())?value:parsed.toLocaleString();
}

function lifecycle(row:DeliveryShareHistoryRow):{label:string;tone:"success"|"warning"|"danger"|"neutral"}{
  if(row.revoked_at)return{label:"revoked",tone:"danger"};
  if(row.unavailable_since)return{label:"unavailable",tone:"warning"};
  if(row.expires_at&&new Date(row.expires_at).valueOf()<=Date.now())return{label:"expired",tone:"neutral"};
  return{label:"active",tone:"success"};
}

export function DeliveryLinksPage({canRevoke,onChanged}:{canRevoke:boolean;onChanged?:()=>void}){
  const readRoute=()=>{
    const parameters=new URLSearchParams(window.location.search);
    return {query:(parameters.get("q")||"").trim(),prefix:(parameters.get("prefix")||"").trim()};
  };
  const [route,setRoute]=useState(readRoute);
  const {query,prefix}=route;
  const [draft,setDraft]=useState(route.query);
  const [rows,setRows]=useState<DeliveryShareHistoryRow[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [loadError,setLoadError]=useState<{message:string;cursor?:string}|null>(null);
  const [mutationError,setMutationError]=useState("");
  const [busy,setBusy]=useState<string|null>(null);
  const pending=useRef<AbortController|null>(null);
  const requestVersion=useRef(0);
  const routeKey=useRef("");
  const mounted=useRef(true);
  const confirmedRevocations=useRef(new Map<string,string>());
  routeKey.current=JSON.stringify([query,prefix]);

  const load=useCallback(async(cursor?:string)=>{
    pending.current?.abort();
    const controller=new AbortController();
    pending.current=controller;
    const version=++requestVersion.current;
    const current=()=>mounted.current&&!controller.signal.aborted&&requestVersion.current===version;
    cursor?setLoadingMore(true):setLoading(true);
    if(!cursor)setLoadingMore(false);
    setLoadError(null);
    try{
      const parameters=new URLSearchParams({limit:"50"});
      if(query)parameters.set("q",query);
      if(prefix)parameters.set("prefix",prefix);
      if(cursor)parameters.set("cursor",cursor);
      const result=await api<DeliveryShareHistoryResponse>(`/api/delivery/shares?${parameters}`,{signal:controller.signal});
      if(!current())return;
      setRows(previous=>{
        const merged=cursor?[...new Map([...previous,...result.shares].map(row=>[row.id,row])).values()]:result.shares;
        return merged.map(row=>{
          const revokedAt=confirmedRevocations.current.get(row.id);
          return revokedAt?{...row,revoked_at:row.revoked_at||revokedAt}:row;
        });
      });
      setNextCursor(result.nextCursor);
    }catch(caught){
      if(current())setLoadError({message:caught instanceof Error?caught.message:"Client links could not be loaded.",cursor});
    }finally{
      if(current()){setLoading(false);setLoadingMore(false);}
    }
  },[query,prefix]);

  useEffect(()=>{
    setRows([]);setNextCursor(null);setMutationError("");
    void load();
    return()=>{pending.current?.abort();requestVersion.current+=1;};
  },[load]);

  useEffect(()=>{
    mounted.current=true;
    const restore=()=>{
      const next=readRoute();
      if(routeKey.current===JSON.stringify([next.query,next.prefix])){setDraft(next.query);return;}
      pending.current?.abort();requestVersion.current+=1;
      routeKey.current=JSON.stringify([next.query,next.prefix]);
      setRoute(next);setDraft(next.query);
    };
    window.addEventListener("popstate",restore);
    return()=>{mounted.current=false;pending.current?.abort();requestVersion.current+=1;window.removeEventListener("popstate",restore);};
  },[]);

  const routeUrl=(next:{query:string;prefix:string})=>{
    const url=new URL(window.location.href);
    next.query?url.searchParams.set("q",next.query):url.searchParams.delete("q");
    next.prefix?url.searchParams.set("prefix",next.prefix):url.searchParams.delete("prefix");
    return `${url.pathname}${url.search}${url.hash}`;
  };

  const navigate=(next:{query:string;prefix:string})=>{
    setDraft(next.query);
    if(next.query===query&&next.prefix===prefix){void load();return;}
    pending.current?.abort();requestVersion.current+=1;
    routeKey.current=JSON.stringify([next.query,next.prefix]);
    window.history.pushState(window.history.state,"",routeUrl(next));
    setRoute(next);
  };

  const search=(event:FormEvent)=>{
    event.preventDefault();
    navigate({query:draft.trim(),prefix});
  };

  const revoke=async(row:DeliveryShareHistoryRow)=>{
    if(busy)return;
    if(!confirm(`Revoke the client link for ${row.display_name}? Anyone using it will lose access.`))return;
    const mutationRoute=routeKey.current;
    setBusy(row.id);setMutationError("");
    try{
      await api(`/api/delivery/shares/${encodeURIComponent(row.id)}`,{method:"DELETE"});
      if(!mounted.current)return;
      // A successful mutation remains authoritative when the operator searches
      // elsewhere, even if a pending read still contains a pre-revoke snapshot.
      const revokedAt=new Date().toISOString();
      confirmedRevocations.current.set(row.id,revokedAt);
      setRows(current=>current.map(item=>item.id===row.id?{...item,revoked_at:item.revoked_at||revokedAt}:item));
      onChanged?.();
    }catch(caught){if(mounted.current&&routeKey.current===mutationRoute)setMutationError(caught instanceof Error?caught.message:"The client link could not be revoked.");}
    finally{if(mounted.current)setBusy(null);}
  };

  const folderName=prefix.replace(/^Jobs\/Clients\//,"").replace(/^Jobs\//,"").replace(/\/+$/,"").split("/").filter(Boolean).join(" / ")||"Client delivery";

  return <div className="page-stack delivery-links-page">
    <div className="page-heading">
      <div><span className="eyebrow">Client delivery</span><h1>Client links</h1><p>Search and manage links without loading the complete history at once.</p></div>
      <a className="button button-ghost" href={prefix?deliveryPathFromPrefix(prefix):"/delivery"}>{prefix?"Back to folder":"Back to Data"}</a>
    </div>
    {prefix&&<div className="delivery-links-scope" role="region" aria-label="Link history scope">
      <div><strong>Folder: {folderName}</strong><p>Showing links in this folder and its subfolders.</p></div>
      <div className="delivery-links-scope-actions"><a className="button button-ghost button-small" href={routeUrl({query,prefix:""})} onClick={event=>{
        if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
        event.preventDefault();navigate({query,prefix:""});
      }}>View all links</a></div>
    </div>}
    <Card title="Find a client link">
      <form className="delivery-links-search" onSubmit={search} role="search">
        <label className="delivery-links-search-field">Search
          <input value={draft} onChange={event=>setDraft(event.target.value)} placeholder="Client, project, label, file, or folder" maxLength={165}/>
        </label>
        <div className="delivery-links-search-actions">
        <button className="button-orange" type="submit">Search</button>
        {(query||draft)&&<button className="button-ghost" type="button" onClick={()=>navigate({query:"",prefix})}>Clear</button>}
        </div>
      </form>
      <small className="delivery-links-search-help">Searches match the link label, client, project, or target name. Use <code>path:search text</code> to search the complete storage path.{prefix?" Search stays within this folder.":""}</small>
    </Card>
    <Card title={query?`Results for “${query}”`:prefix?"Folder client links":"All client links"} action={<button className="button-ghost button-small" onClick={()=>void load()} disabled={loading||Boolean(busy)}>Refresh</button>}>
      {loadError&&<div className="notice error-notice delivery-links-error" role="alert"><span>{loadError.message}</span><button className="button-ghost button-small" onClick={()=>void load(loadError.cursor)}>Retry</button></div>}
      {mutationError&&<div className="notice error-notice" role="alert">{mutationError}</div>}
      {loading?<Loading/>:rows.length?<>
        <div className="table-wrap delivery-links-table"><table>
          <thead><tr><th>Target</th><th>Client and project</th><th>Created</th><th>Security</th><th>Status</th>{canRevoke&&<th>Action</th>}</tr></thead>
          <tbody>{rows.map(row=>{const status=lifecycle(row);return <tr key={row.id}>
            <td><strong>{row.label||row.display_name}</strong><small>{row.target_kind} · <code>{row.target_path}</code></small></td>
            <td>{row.client_name}<small>{row.project_name}</small></td>
            <td>{shownDate(row.created_at)}<small>{row.last_accessed_at?`Last opened ${shownDate(row.last_accessed_at)}`:"Not opened yet"}</small></td>
            <td>{row.password_protected?"Access code":"Complete link"}<small>{row.access_count||0} opens</small></td>
            <td><StatusPill tone={status.tone}>{status.label}</StatusPill></td>
            {canRevoke&&<td>{!row.revoked_at&&<button className="button-danger button-small" disabled={Boolean(busy)||loadingMore} onClick={()=>void revoke(row)}>{busy===row.id?"Revoking…":"Revoke"}</button>}</td>}
          </tr>;})}</tbody>
        </table></div>
        {nextCursor&&<div className="delivery-links-pagination"><button className="button-ghost" disabled={loadingMore||Boolean(busy)} onClick={()=>void load(nextCursor)}>{loadingMore?"Loading…":"Load more"}</button></div>}
      </>:!loadError&&<EmptyState title="No client links found" detail={query?"Try another name or use path: followed by part of the storage path.":prefix?"No links have been created in this folder yet.":"Links created from Data will appear here."}/>}
    </Card>
  </div>;
}
