import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Card, EmptyState, Loading } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import type { PortalFile, PortalFilePage, PortalProject } from "./portal-api";
import type { ClientPortalPage } from "./portal-route";
import { clientProjectPath } from "./portal-route";
import { loadNativeDeliveries, loadNativeFile, loadNativeFolder, loadNativeHierarchy, type NativeDeliveryTarget, type NativeHierarchy, type NativePortalBootstrap, type NativeWorkspaceFeatureKey, type NativeWorkspaceFeatureReadiness, type NativeWorkspaceFeatureState } from "./native-portal-api";
import { LeaveFeedback,PortalFeedback } from './PortalFeedback';
import "./NativeWorkspaceContent.css";

export interface NativeFileBrowserOptions {
  folderId: string | null;
  load: (folderId: string | null, cursor: string | null, signal: AbortSignal) => Promise<PortalFilePage>;
  loadExactFile: (fileId: string, signal: AbortSignal) => Promise<PortalFile>;
  onFolderChange: (folderId: string | null) => void;
  onLinkedFileChange: () => void;
}
const contextError = (caught: unknown) => [401, 403, 404, 409, 410].includes((caught as RequestError).status ?? 0);
function workspacePath(path: string, workspaceId: string): string {
  const url = new URL(path, location.origin); url.searchParams.set("workspace", workspaceId); return `${url.pathname}${url.search}`;
}
const featureOrder: NativeWorkspaceFeatureKey[] = ["directory", "deliveries", "serviceRequests", "feedback", "models", "team", "billing"];
const featureLabels: Record<NativeWorkspaceFeatureKey, string> = {
  directory: "Projects and directory", deliveries: "Delivery files", serviceRequests: "Service requests", feedback: "Feedback",
  models: "3D models", team: "Workspace members", billing: "Billing",
};
const stateLabels: Record<NativeWorkspaceFeatureState, string> = {
  available: "Ready", not_in_access: "Not in access", not_supported: "Not connected", temporarily_unavailable: "Temporarily unavailable",
};
function featureDetail(key: NativeWorkspaceFeatureKey, readiness: NativeWorkspaceFeatureReadiness): string {
  const status = readiness[key];
  if (key === "directory") return status.state === "available"
    ? "Authorized directory and project records can be browsed. Every record is checked against current access before it is shown."
    : "Directory viewing is not included in this workspace's current access.";
  if (key === "deliveries") return status.state === "available"
    ? "Shared delivery folders are ready. Each folder and file is authorized again when it is opened."
    : "The delivery backend is not ready for this workspace. Existing shares and files have not been removed.";
  if (key === "serviceRequests") return status.state === "available"
    ? "Service requests are available through this exact connected source. Project access and request authority are checked again for every change."
    : "New service requests are not connected for this Project Alpha source. Existing authorized request history remains unchanged.";
  if (key === "feedback") return status.state === "available"
    ? "Feedback is ready for individually authorized projects and delivery items. Access is checked again when feedback is sent or opened."
    : status.state === "not_in_access" ? "Feedback is not in your current directory access." : "Feedback storage is not ready for this workspace.";
  if (key === "models") return "3D model viewing is not connected for this Project Alpha source.";
  if (key === "team") return "Workspace member management is not connected for this Project Alpha source.";
  return "Billing is managed by the source system and is not connected in this workspace.";
}
function FeatureReadiness({features}: {features: NativeWorkspaceFeatureReadiness}) {
  return <Card title="Workspace features">
    <p>These statuses show what this connected workspace can operate right now. They are not services purchased or assigned to your organization.</p>
    <ul className="native-feature-list">{featureOrder.map(key => <li key={key}>
      <div><strong>{featureLabels[key]}</strong><small>{featureDetail(key, features)}</small></div>
      <span className={`native-feature-status native-feature-status-${features[key].state}`}>{stateLabels[features[key].state]}</span>
    </li>)}</ul>
  </Card>;
}

export function NativeWorkspaceContent({ context, page, projectId, feedbackId, onInvalid, renderFiles, openProject, renderTeam, renderRequests }: {
  context: NativePortalBootstrap; page: ClientPortalPage; projectId: string | null; feedbackId?: string | null;
  onInvalid: (caught: unknown) => void; renderFiles: (options: NativeFileBrowserOptions) => ReactNode; openProject: (id: string) => void;
  renderTeam?: () => ReactNode;
  renderRequests?: (projects: PortalProject[], projectId?: string) => ReactNode;
}) {
  const [locationSearch, setLocationSearch] = useState(location.search);
  const [hierarchy, setHierarchy] = useState<NativeHierarchy["entries"]>([]);
  const [hierarchyCursor, setHierarchyCursor] = useState<string | null>(null);
  const [targets, setTargets] = useState<NativeDeliveryTarget[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(false), [deliveryLoading, setDeliveryLoading] = useState(false);
  const [hierarchyError, setHierarchyError] = useState(""), [deliveryError, setDeliveryError] = useState("");
  const [hierarchyRetry, setHierarchyRetry] = useState(0), [deliveryRetry, setDeliveryRetry] = useState(0);
  const invalid = useRef(onInvalid); invalid.current = onInvalid;
  const contextController = useRef(new AbortController());
  const deliveryController = useRef<AbortController | null>(null), deliverySequence = useRef(0);
  const hierarchyController = useRef<AbortController | null>(null), hierarchySequence = useRef(0);
  const params = new URLSearchParams(locationSearch), folderId = params.get("folder"), linkedFile = params.get("file");
  const relevantHierarchy = ["dashboard", "projects", "project", "requests", "request-new"].includes(page);
  const relevantDeliveries = page === "deliveries" && !folderId && !linkedFile;
  useEffect(() => { const controller = new AbortController(); contextController.current = controller; return () => { controller.abort(); deliveryController.current?.abort(); hierarchyController.current?.abort(); }; }, [context]);
  useEffect(() => { setLocationSearch(location.search); const sync = () => setLocationSearch(location.search); addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, [page, projectId]);
  const fail = useCallback((caught: unknown) => {
    if (contextError(caught) && !contextController.current.signal.aborted) { contextController.current.abort(); deliveryController.current?.abort(); hierarchyController.current?.abort(); setHierarchy([]); setHierarchyCursor(null); setTargets([]); setCursor(null); invalid.current(caught); }
  }, []);
  const fetchHierarchy = useCallback(async (next: string | null) => {
    if (hierarchyController.current || contextController.current.signal.aborted) return;
    const controller = new AbortController(), sequence = ++hierarchySequence.current; hierarchyController.current = controller;
    setHierarchyError(""); setHierarchyLoading(true);
    try {
      const result = await loadNativeHierarchy(context, controller.signal, next);
      if (controller.signal.aborted || contextController.current.signal.aborted || sequence !== hierarchySequence.current) return;
      setHierarchy(current => { const keys = new Set(next ? current.map(entry => `${entry.type}:${entry.publicId}`) : []); return [...(next ? current : []), ...result.entries.filter(entry => !keys.has(`${entry.type}:${entry.publicId}`))]; }); setHierarchyCursor(result.page.nextCursor);
    } catch (caught) { if (!controller.signal.aborted && !contextController.current.signal.aborted) { fail(caught); setHierarchyError("The workspace directory could not be loaded. Try again."); } }
    finally { if (sequence === hierarchySequence.current) { hierarchyController.current = null; if (!controller.signal.aborted) setHierarchyLoading(false); } }
  }, [context, fail]);
  useEffect(() => {
    if (!relevantHierarchy || !context.capabilities.directoryRead) return;
    setHierarchy([]); setHierarchyCursor(null); void fetchHierarchy(null);
    return () => { hierarchySequence.current++; hierarchyController.current?.abort(); hierarchyController.current = null; };
  }, [context.capabilities.directoryRead, relevantHierarchy, hierarchyRetry, fetchHierarchy]);
  const fetchDeliveries = useCallback(async (next: string | null) => {
    if (deliveryController.current || contextController.current.signal.aborted) return;
    const controller = new AbortController(), sequence = ++deliverySequence.current; deliveryController.current = controller;
    setDeliveryLoading(true); setDeliveryError("");
    try {
      const result = await loadNativeDeliveries(context, next, controller.signal);
      if (controller.signal.aborted || contextController.current.signal.aborted || sequence !== deliverySequence.current) return;
      setTargets(current => { const ids = new Set(next ? current.map(item => item.id) : []); return [...(next ? current : []), ...result.items.filter(item => !ids.has(item.id))]; }); setCursor(result.page.nextCursor);
    } catch (caught) { if (!controller.signal.aborted && !contextController.current.signal.aborted) { fail(caught); setDeliveryError("Delivery folders could not be loaded. Try again."); } }
    finally { if (sequence === deliverySequence.current) { deliveryController.current = null; if (!controller.signal.aborted) setDeliveryLoading(false); } }
  }, [context, fail]);
  useEffect(() => {
    if (!relevantDeliveries || !context.capabilities.deliveryView) return;
    setTargets([]); setCursor(null); void fetchDeliveries(null);
    return () => { deliverySequence.current++; deliveryController.current?.abort(); deliveryController.current = null; };
  }, [relevantDeliveries, context.capabilities.deliveryView, fetchDeliveries, deliveryRetry]);
  const navigateFolder = (id: string | null) => {
    const url = new URL("/portal/deliveries", location.origin); url.searchParams.set("workspace", context.workspace.id); if (id) url.searchParams.set("folder", id);
    history.pushState(null, "", `${url.pathname}${url.search}`); setLocationSearch(url.search);
  };
  const syncLinkedFile = useCallback(() => setLocationSearch(location.search), []);
  const filesLoad = useCallback(async (folder: string | null, next: string | null, signal: AbortSignal) => {
    if (!folder) return { files: [], folders: [], breadcrumbs: [], folderId: null, prefix: "", cursor: null };
    try { return await loadNativeFolder(context, folder, next, signal); } catch (caught) { if (!signal.aborted) fail(caught); throw caught; }
  }, [context, fail]);
  const exactLoad = useCallback(async (fileId: string, signal: AbortSignal) => {
    try { return await loadNativeFile(context, fileId, signal); } catch (caught) { if (!signal.aborted) fail(caught); throw caught; }
  }, [context, fail]);
  const entries = page === "projects" ? hierarchy.filter(entry => entry.type === "project") : page === "project" ? hierarchy.filter(entry => entry.type === "project" && entry.publicId === projectId) : hierarchy;
  const entryLabels = new Map(hierarchy.map(entry => [`${entry.type}:${entry.publicId}`, entry.displayName]));
  const requestProjects: PortalProject[] = hierarchy.filter(entry => entry.type === "project").map(entry => ({
    id: entry.publicId, externalRef: entry.publicId, clientName: context.workspace.displayName,
    projectName: entry.displayName, canRequestService: true, status: "active", summary: null,
    siteAddress: null, serviceAddress: null, projectContactName: null, projectContactEmail: null,
    projectContactPhone: null, nextMilestone: null, lastUpdateAt: null,
  }));
  const parentLabel = (entry: NativeHierarchy["entries"][number]) => entry.parentType && entry.parentPublicId ? entryLabels.get(`${entry.parentType}:${entry.parentPublicId}`) : undefined;
  const projectTab = params.get("tab") ?? "";
  const unsupportedRoute = ((page === "requests" || page === "request-new" || (page === "project" && projectTab === "requests")) && !context.capabilities.requestV2) ||
    (page === "feedback" && !context.capabilities.feedback) || (page === "project" && projectTab === "models");
  const unavailableFeature: NativeWorkspaceFeatureKey = page === "feedback" ? "feedback"
    : page === "project" && params.get("tab") === "models" ? "models" : "serviceRequests";

  return <section className="native-workspace" aria-label="Connected client workspace">
    <header className="portal-welcome"><span className="eyebrow">Connected workspace</span><h1>{context.workspace.displayName}</h1><p className="native-workspace-source">Source: {context.workspace.sourceId}</p></header>
    {unsupportedRoute ? <><Card title="Feature unavailable"><p>{featureDetail(unavailableFeature, context.features)}</p></Card><FeatureReadiness features={context.features} /></> :
      ((page === "requests" || page === "request-new") || (page === "project" && projectTab === "requests")) && context.capabilities.requestV2 && renderRequests
        ? renderRequests(requestProjects, page === "project" ? projectId ?? undefined : undefined)
        : page === "feedback" ? <PortalFeedback nativeWorkspaceId={context.workspace.id} id={feedbackId} /> : page === "account" ? <><Card title="Workspace access"><p>You are viewing resources shared with your signed-in identity in this workspace. Access is evaluated from the current Project Alpha source and workspace authorization.</p></Card>{renderTeam?.()}<FeatureReadiness features={context.features} /></> : page === "not-found" ? <Card title="Page unavailable"><p>This page is not available in this workspace.</p></Card> : relevantHierarchy ? <>
      <Card title={page === "dashboard" ? "Workspace directory" : page === "project" ? "Project" : "Projects"}>
        {!context.capabilities.directoryRead ? <p>The directory is not included in your current workspace access.</p> : <>
          {hierarchyError && <div role="alert"><p>{hierarchyError}</p><button className="button-ghost" onClick={() => hierarchyCursor ? void fetchHierarchy(hierarchyCursor) : setHierarchyRetry(value => value + 1)}>Retry directory</button></div>}
          {entries.length > 0 && <ul className="native-workspace-list">{entries.map(entry => <li key={`${entry.type}:${entry.publicId}`}><div><strong>{entry.displayName}</strong><small>{entry.type.replaceAll("_", " ")}{parentLabel(entry) ? ` · ${parentLabel(entry)}` : ""}</small></div>{entry.type === "project" && <div>{page !== "project" && <a className="button button-ghost" href={workspacePath(clientProjectPath(entry.publicId), context.workspace.id)} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); openProject(entry.publicId); } }}>Open project<span className="visually-hidden">: {entry.displayName}</span></a>}{context.capabilities.feedback && <LeaveFeedback target={{kind:'project',projectId:entry.publicId}} label={entry.displayName} compact nativeWorkspaceId={context.workspace.id} />}</div>}</li>)}</ul>}
          {hierarchyLoading && <Loading />}
          {!hierarchyLoading && !hierarchyError && entries.length === 0 && <EmptyState title={hierarchyCursor ? "No matching records loaded yet" : page === "project" ? "Project unavailable" : "No directory entries shared"} detail={hierarchyCursor ? "Continue through the accessible directory pages to check more records." : "Only records included in your current access are shown."} />}
          {hierarchyCursor && <><p>Showing loaded records only. More accessible directory pages are available.</p><button className="button-ghost" disabled={hierarchyLoading} onClick={() => void fetchHierarchy(hierarchyCursor)}>Load more directory records</button></>}
        </>}
        {context.capabilities.deliveryView && <a className="button button-orange" href={workspacePath("/portal/deliveries", context.workspace.id)}>Browse workspace deliveries</a>}
      </Card>
      {page === "dashboard" && <FeatureReadiness features={context.features} />}
    </> : page === "deliveries" ? !context.capabilities.deliveryView ? <Card title="Deliveries unavailable"><p>Delivery viewing is not included in your current workspace access.</p></Card> : <>
      {(folderId || linkedFile) && <Card title="Delivery files"><button className="button-ghost" onClick={() => navigateFolder(null)}>All delivery folders</button>{renderFiles({ folderId, load: filesLoad, loadExactFile: exactLoad, onFolderChange: navigateFolder, onLinkedFileChange: syncLinkedFile })}</Card>}
      {!folderId && !linkedFile && <Card title="Shared delivery folders">
        <p>Folders explicitly shared with you in this workspace.</p>
        {deliveryError && <div role="alert"><p>{deliveryError}</p><button className="button-ghost" onClick={() => cursor ? void fetchDeliveries(cursor) : setDeliveryRetry(value => value + 1)}>Retry delivery folders</button></div>}
        {targets.length > 0 && <ul className="native-workspace-list">{targets.map(target => <li key={target.id}><div><strong>{target.displayName}</strong><small>{target.owner.type.replaceAll("_", " ")}</small></div><div><button className="button-orange" onClick={() => navigateFolder(target.id)}>Open folder<span className="visually-hidden">: {target.displayName}</span></button>{context.capabilities.feedback && <LeaveFeedback target={{kind:'folder',projectId:target.owner.type==='project'?target.owner.publicId:null,folderId:target.id}} label={target.displayName} compact nativeWorkspaceId={context.workspace.id} />}</div></li>)}</ul>}
        {deliveryLoading && <Loading />}
        {!deliveryLoading && !deliveryError && targets.length === 0 && <p>{cursor ? "No folders on this page. Continue to check the remaining shared folders." : "No delivery folders are currently shared with you."}</p>}
        {cursor && <button className="button-ghost" disabled={deliveryLoading} onClick={() => void fetchDeliveries(cursor)}>Load more delivery folders</button>}
      </Card>}
    </> : null}
  </section>;
}
