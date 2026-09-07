import { useEffect, useRef, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import type { ClientFeedbackStatus, ProjectFeedbackHistoryItem, ProjectFeedbackHistoryPage } from "@ltds/shared";
import { api, ApiError } from "./api";
import { businessTimestamp, type ClientKind, type ClientRootNamespace } from "./ClientDirectory";
import "./ProjectFeedbackHistory.css";

interface HistoryRoot { sourceId: string; rootNamespace: ClientRootNamespace; kind: ClientKind; publicId: string }
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rootKey = (root: HistoryRoot) => JSON.stringify([root.sourceId,root.rootNamespace,root.kind,root.publicId]);
const statusTone = (status: ClientFeedbackStatus): "neutral" | "warning" | "success" =>
  status === "done" ? "success" : status === "in_progress" ? "warning" : "neutral";
const statusLabel = (status: ClientFeedbackStatus) => status === "in_progress" ? "In progress" : status === "done" ? "Done" : "New";
const eventLabel = (action: ProjectFeedbackHistoryItem["events"][number]["action"]) =>
  action === "submitted" ? "Feedback submitted" : action === "started" ? "Work started" : "Marked done";

function safeDetailPath(value: string, feedbackId: string): boolean {
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value,location.origin);
    return url.origin === location.origin && (url.pathname === `/clients/feedback/${encodeURIComponent(feedbackId)}` || url.pathname === `/operations/feedback/${encodeURIComponent(feedbackId)}`)
      && url.searchParams.size === 1 && url.searchParams.get("status") === "all";
  } catch { return false; }
}
function validItem(value: unknown, asOf: string): value is ProjectFeedbackHistoryItem {
  if (!record(value) || !exactKeys(value,["feedbackId","createdAt","status","events","detailPath"])
    || typeof value.feedbackId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.feedbackId)
    || !["new","in_progress","done"].includes(String(value.status)) || !businessTimestamp(value.createdAt as string)
    || String(value.createdAt)>asOf
    || typeof value.detailPath !== "string" || !safeDetailPath(value.detailPath,value.feedbackId)
    || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 3) return false;
  const expectedActions = ["submitted","started","completed"];
  for (let index=0;index<value.events.length;index++) {
    const event=value.events[index];
    if (!record(event) || !exactKeys(event,["revision","action","occurredAt"]) || event.revision!==index+1
      || event.action!==expectedActions[index] && !(index===1 && value.events.length===2 && value.status==="done" && event.action==="completed")
      || !businessTimestamp(event.occurredAt as string) || String(event.occurredAt)>asOf) return false;
  }
  const last=value.events.at(-1)!;
  return (value.status==="new"&&last.action==="submitted") || (value.status==="in_progress"&&last.action==="started")
    || (value.status==="done"&&last.action==="completed");
}
function validPage(value: unknown, root: HistoryRoot, projectId: string, contextVersion: string,
  priorCursor: string | null): value is ProjectFeedbackHistoryPage {
  if (!record(value) || !record(value.canonicalRoot) || !record(value.page) || value.coverage!=="feedback_only"
    || value.projectId!==projectId || value.contextVersion!==contextVersion || rootKey(value.canonicalRoot as unknown as HistoryRoot)!==rootKey(root)
    || !businessTimestamp(value.refreshedAt as string) || !businessTimestamp(value.asOf as string) || !Array.isArray(value.items)) return false;
  const page=value.page, available=page.available;
  return typeof available==="boolean" && (page.reason===null || page.reason==="unsupported_source")
    && typeof page.hasMore==="boolean" && (page.nextCursor===null || typeof page.nextCursor==="string")
    && Number.isInteger(page.returned) && Number.isInteger(page.limit) && Number(page.limit)>=1 && Number(page.limit)<=100
    && page.returned===value.items.length && value.items.length<=Number(page.limit)
    && (available || value.items.length===0&&page.hasMore===false&&page.nextCursor===null)
    && (!page.hasMore || Boolean(page.nextCursor)&&page.nextCursor!==priorCursor)
    && value.items.every(item=>validItem(item,String(value.asOf)));
}

/** Lazy read-only feedback lifecycle. Parent context owns invalidation. */
export function ProjectFeedbackHistory({root,projectId,contextVersion,contextSignal,onInvalidated}:{
  root:HistoryRoot;projectId:string;contextVersion:string;contextSignal:AbortSignal;
  onInvalidated:(message:string,status?:number)=>void;
}) {
  const [items,setItems]=useState<ProjectFeedbackHistoryItem[]>([]),[page,setPage]=useState<ProjectFeedbackHistoryPage["page"]|null>(null);
  const [requested,setRequested]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const pending=useRef<AbortController|null>(null),sequence=useRef(0),failedCursor=useRef<string|null>(null);
  const identity=rootKey(root);
  useEffect(()=>{
    const abort=()=>{pending.current?.abort();pending.current=null;sequence.current+=1;};
    setItems([]);setPage(null);setRequested(false);setBusy(false);setError("");failedCursor.current=null;
    contextSignal.addEventListener("abort",abort);
    return()=>{contextSignal.removeEventListener("abort",abort);abort();};
  },[identity,projectId,contextVersion,contextSignal]);
  const load=async(cursor:string|null)=>{
    if(contextSignal.aborted||pending.current||root.rootNamespace!=="business")return;
    const controller=new AbortController(),request=++sequence.current;pending.current=controller;
    setRequested(true);setBusy(true);setError("");if(!cursor){setItems([]);setPage(null);}
    try{
      const kind=root.kind==="organization"?"organizations":"standalone";
      const path=`/api/client-hub/sources/${encodeURIComponent(root.sourceId)}/business/${kind}/${encodeURIComponent(root.publicId)}/business-projects/${encodeURIComponent(projectId)}/feedback-history`;
      const params=new URLSearchParams({expectedContextVersion:contextVersion,limit:cursor?"25":"5"});if(cursor)params.set("cursor",cursor);
      const result=await api<ProjectFeedbackHistoryPage>(`${path}?${params}`,{signal:controller.signal});
      if(contextSignal.aborted||controller.signal.aborted||sequence.current!==request)return;
      if(!validPage(result,root,projectId,contextVersion,cursor))throw new Error("This feedback history could not be verified. Retry this section.");
      if(cursor&&!result.page.available)throw new ApiError("Access to project feedback changed. Refresh the project workspace.",403,{});
      setItems(previous=>[...new Map([...(cursor?previous:[]),...result.items].map(item=>[item.feedbackId,item])).values()]);
      setPage(result.page);failedCursor.current=null;
    }catch(caught){
      if(contextSignal.aborted||controller.signal.aborted||sequence.current!==request)return;
      const message=caught instanceof Error?caught.message:"Project feedback history could not be loaded.";
      if(caught instanceof ApiError&&[401,403,404,409].includes(caught.status)){setItems([]);setPage(null);onInvalidated(message,caught.status);}
      else{setError(message);failedCursor.current=cursor;}
    }finally{if(!contextSignal.aborted&&!controller.signal.aborted&&sequence.current===request){pending.current=null;setBusy(false);}}
  };
  if(root.rootNamespace!=="business")return null;
  const canContinue=Boolean(page?.available&&page.hasMore&&page.nextCursor),finished=Boolean(requested&&page&&!canContinue&&!error);
  return <Card title="Project feedback history"><section className="project-feedback-history" aria-label="Project feedback history" aria-busy={busy}>
    <p>Feedback submissions and status changes for this project. This is not a complete project activity or audit history.</p>
    {items.length>0&&<ol>{items.map((item,index)=><li key={item.feedbackId}>
      <div className="project-feedback-history-summary"><strong>Feedback</strong><StatusPill tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusPill></div>
      <time dateTime={item.createdAt}>Submitted {new Date(item.createdAt).toLocaleString([],{dateStyle:"medium",timeStyle:"short"})}</time>
      <ol aria-label={`Lifecycle for feedback ${item.feedbackId}`}>{item.events.map(event=><li key={event.revision}>
        <span>{eventLabel(event.action)}</span><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString([],{dateStyle:"medium",timeStyle:"short"})}</time>
      </li>)}</ol>
      <a href={item.detailPath} aria-label={`Open ${statusLabel(item.status).toLocaleLowerCase("en-US")} feedback ${index+1} submitted ${new Date(item.createdAt).toLocaleString([],{dateStyle:"medium",timeStyle:"short"})}`}>Open feedback review</a>
    </li>)}</ol>}
    {requested&&!busy&&!error&&page?.available&&!items.length&&<p>{canContinue?"No accessible feedback on this page. Continue checking for more.":"No project feedback is recorded yet."}</p>}
    {requested&&<p role="status">{items.length} feedback {items.length===1?"record":"records"} shown{busy?" · Loading…":""}</p>}
    {error&&<p role="alert">{error}</p>}
    <div className="project-feedback-history-actions"><button type="button" className="button-ghost" aria-disabled={busy||finished}
      onClick={()=>{if(!busy&&!finished)void load(error?failedCursor.current:requested?page?.nextCursor||null:null);}}>
      {busy?"Loading feedback history…":error?"Retry feedback history":!requested?"Show feedback history":canContinue?"Load more feedback history":"Feedback history loaded"}</button>
      {requested&&<button type="button" className="button-ghost" aria-disabled={busy}
        onClick={()=>{if(!busy)void load(null);}}>Refresh feedback history</button>}
    </div>
  </section></Card>;
}
