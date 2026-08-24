import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api } from "./api";

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
  const initialQuery=new URLSearchParams(window.location.search).get("q")||"";
  const [draft,setDraft]=useState(initialQuery);
  const [query,setQuery]=useState(initialQuery);
  const [rows,setRows]=useState<DeliveryShareHistoryRow[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState<string|null>(null);

  const load=useCallback(async(cursor?:string)=>{
    cursor?setLoadingMore(true):setLoading(true);
    setError("");
    try{
      const parameters=new URLSearchParams({limit:"50"});
      if(query)parameters.set("q",query);
      if(cursor)parameters.set("cursor",cursor);
      const result=await api<DeliveryShareHistoryResponse>(`/api/delivery/shares?${parameters}`);
      setRows(current=>cursor?[...current,...result.shares]:result.shares);
      setNextCursor(result.nextCursor);
    }catch(caught){
      setError(caught instanceof Error?caught.message:"Client links could not be loaded.");
    }finally{
      setLoading(false);setLoadingMore(false);
    }
  },[query]);

  useEffect(()=>{void load();},[load]);

  const search=(event:FormEvent)=>{
    event.preventDefault();
    const normalized=draft.trim();
    const url=new URL(window.location.href);
    normalized?url.searchParams.set("q",normalized):url.searchParams.delete("q");
    window.history.replaceState(window.history.state,"",`${url.pathname}${url.search}${url.hash}`);
    if(normalized===query)void load();
    else setQuery(normalized);
  };

  const revoke=async(row:DeliveryShareHistoryRow)=>{
    if(!confirm(`Revoke the client link for ${row.display_name}? Anyone using it will lose access.`))return;
    setBusy(row.id);setError("");
    try{
      await api(`/api/delivery/shares/${encodeURIComponent(row.id)}`,{method:"DELETE"});
      setRows(current=>current.map(item=>item.id===row.id?{...item,revoked_at:new Date().toISOString()}:item));
      onChanged?.();
    }catch(caught){setError(caught instanceof Error?caught.message:"The client link could not be revoked.");}
    finally{setBusy(null);}
  };

  return <div className="page-stack">
    <div className="page-heading">
      <div><span className="eyebrow">Client delivery</span><h1>Client links</h1><p>Search and manage links without loading the complete history at once.</p></div>
      <a className="button-ghost" href="/delivery">Back to Data</a>
    </div>
    <Card title="Find a client link">
      <form className="toolbar" onSubmit={search} role="search">
        <label className="field-grow">Search
          <input value={draft} onChange={event=>setDraft(event.target.value)} placeholder="Client, project, label, file, or folder" maxLength={165}/>
        </label>
        <button className="button-orange" type="submit">Search</button>
        {(query||draft)&&<button className="button-ghost" type="button" onClick={()=>{setDraft("");setQuery("");window.history.replaceState(window.history.state,"",window.location.pathname);}}>Clear</button>}
      </form>
      <small>Searches match the link label, client, project, or target name. Use <code>path:search text</code> to search the complete storage path.</small>
    </Card>
    <Card title={query?`Results for “${query}”`:"All client links"} action={<button className="button-ghost button-small" onClick={()=>void load()} disabled={loading}>Refresh</button>}>
      {error&&<div className="notice error-notice" role="alert">{error}</div>}
      {loading?<Loading/>:rows.length?<>
        <div className="table-wrap"><table>
          <thead><tr><th>Target</th><th>Client and project</th><th>Created</th><th>Security</th><th>Status</th>{canRevoke&&<th>Action</th>}</tr></thead>
          <tbody>{rows.map(row=>{const status=lifecycle(row);return <tr key={row.id}>
            <td><strong>{row.label||row.display_name}</strong><small>{row.target_kind} · <code>{row.target_path}</code></small></td>
            <td>{row.client_name}<small>{row.project_name}</small></td>
            <td>{shownDate(row.created_at)}<small>{row.last_accessed_at?`Last opened ${shownDate(row.last_accessed_at)}`:"Not opened yet"}</small></td>
            <td>{row.password_protected?"Access code":"Complete link"}<small>{row.access_count||0} opens</small></td>
            <td><StatusPill tone={status.tone}>{status.label}</StatusPill></td>
            {canRevoke&&<td>{!row.revoked_at&&<button className="button-danger button-small" disabled={busy===row.id} onClick={()=>void revoke(row)}>{busy===row.id?"Revoking…":"Revoke"}</button>}</td>}
          </tr>;})}</tbody>
        </table></div>
        {nextCursor&&<button className="button-ghost" disabled={loadingMore} onClick={()=>void load(nextCursor)}>{loadingMore?"Loading…":"Load more"}</button>}
      </>:<EmptyState title="No client links found" detail={query?"Try another name or use path: followed by part of the storage path.":"Links created from Data will appear here."}/>}
    </Card>
  </div>;
}
