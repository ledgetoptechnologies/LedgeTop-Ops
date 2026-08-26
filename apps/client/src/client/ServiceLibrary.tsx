import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PortalServiceCatalogItem } from "./portal-api";
import "./ServiceLibrary.css";

type BrowseState = { category: string | null; q: string };
const readBrowseState = (): BrowseState => {
  const params = new URLSearchParams(location.search);
  return { category: params.get("service_category"), q: (params.get("service_q") || "").trim().slice(0, 200) };
};
const categoryLabel = (category: string) => category.trim() || "Uncategorized";
const workAreaLabel = (service: PortalServiceCatalogItem) => service.geometryRequirement === "required"
  ? "Work area required" : service.geometryRequirement === "none" ? "No work area needed" : "Work area optional";

export function ServiceLibrary({ catalog, selected, state, complete, legacy, hasMore, loadingMore, pageError, onLoadMore, onRetry, onSelect, onRemove, onUseCurrent, renderQuestions }: {
  catalog: PortalServiceCatalogItem[];
  selected: PortalServiceCatalogItem[];
  state: "loading" | "ready" | "error";
  complete: boolean; legacy: boolean; hasMore: boolean; loadingMore: boolean; pageError: string; onLoadMore: () => void;
  onRetry: () => void;
  onSelect: (service: PortalServiceCatalogItem) => void;
  onRemove: (service: PortalServiceCatalogItem) => void;
  onUseCurrent: (service: PortalServiceCatalogItem) => void;
  renderQuestions: (service: PortalServiceCatalogItem) => ReactNode;
}) {
  const [browse, setBrowse] = useState(readBrowseState);
  const [draftQuery, setDraftQuery] = useState(browse.q);
  const [visibleCount, setVisibleCount] = useState(24);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const [focusResults, setFocusResults] = useState(false);
  useEffect(() => {
    const sync = () => { const next = readBrowseState(); setBrowse(next); setDraftQuery(next.q); setVisibleCount(24); };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { if (focusResults) { resultsHeading.current?.focus({ preventScroll: true }); setFocusResults(false); } }, [browse, focusResults]);
  const navigate = (next: BrowseState) => {
    const url = new URL(location.href);
    if (next.category !== null) url.searchParams.set("service_category", next.category); else url.searchParams.delete("service_category");
    if (next.q) url.searchParams.set("service_q", next.q); else url.searchParams.delete("service_q");
    if (next.category !== browse.category || next.q !== browse.q) history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setBrowse(next); setDraftQuery(next.q); setVisibleCount(24); setFocusResults(true);
  };
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of catalog) counts.set(service.category, (counts.get(service.category) || 0) + 1);
    return [...counts].sort(([a], [b]) => categoryLabel(a).localeCompare(categoryLabel(b)));
  }, [catalog]);
  const services = useMemo(() => catalog.filter(service => browse.q
    ? `${service.name}\n${service.summary || ""}\n${service.category}`.toLocaleLowerCase().includes(browse.q.toLocaleLowerCase())
    : service.category === browse.category), [catalog, browse]);
  const browsingCategories = browse.category === null && !browse.q;
  const selectedIds = new Set(selected.map(service => service.publicId));
  const changedCount = state === "ready" ? selected.filter(service => {
    const current = catalog.find(item => item.publicId === service.publicId);
    return current ? current.sourceVersion !== service.sourceVersion : complete;
  }).length : 0;

  return <div className="portal-service-library">
    <div className="portal-library-summary"><span>{selected.length} of 10 services selected</span>
      {selected.length > 0 && <a href="#selected-request-services">Review selected services{changedCount ? ` (${changedCount} need review)` : ""}</a>}</div>
    <div className="portal-library-search" role="search" aria-label="Find a service">
      <label>{complete ? "Search all services" : "Search loaded services"}<input maxLength={200} value={draftQuery} onChange={event => setDraftQuery(event.target.value)} placeholder="Service, category, or description"
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); navigate({ category: null, q: draftQuery.trim() }); } }} /></label>
      <button type="button" className="button-ghost" onClick={() => navigate({ category: null, q: draftQuery.trim() })}>Search services</button>
    </div>
    <div className="portal-library-browse">
      <header><h4 ref={resultsHeading} tabIndex={-1}>{browsingCategories ? "Choose a category" : browse.q ? `Results for “${browse.q}”` : categoryLabel(browse.category || "")}</h4>
        {!browsingCategories && <button type="button" className="button-ghost" onClick={() => navigate({ category: null, q: "" })}>All categories</button>}
        <button type="button" className="button-ghost" disabled={state === "loading"} onClick={onRetry}>Refresh service library</button></header>
      {state === "loading" && <p role="status">Loading service library…</p>}
      {state === "error" && <div className="portal-inline-error" role="alert"><p>The service library could not be loaded. Your selections and answers are still shown below.</p><button type="button" className="button-ghost" onClick={onRetry}>Retry service library</button></div>}
      {state === "ready" && legacy && <p>Showing available legacy services (up to 500); synchronized browsing is not ready. Search and category counts cover this loaded list only.</p>}
      {state === "ready" && !legacy && !complete && <p>{catalog.length} services loaded. Search and category counts cover loaded services only; load more to browse the rest.</p>}
      {state === "ready" && catalog.length === 0 && <p>{complete ? "No client-request services are currently published." : "No services are loaded in this page."} Your saved selections have not been removed.</p>}
      {state === "ready" && catalog.length > 0 && (browsingCategories
        ? <div className="portal-service-categories">{categories.map(([category, count]) => <button type="button" key={category} onClick={() => navigate({ category, q: "" })}>
          <strong>{categoryLabel(category)}</strong><span>{count} {count === 1 ? "service" : "services"}</span></button>)}</div>
        : <><p className="portal-library-result-count" role="status">{services.length} {services.length === 1 ? "service" : "services"} found.</p>
          {!services.length && <p>No services match this selection. Try another search or return to all categories.</p>}
          <div className="portal-library-results">{services.slice(0, visibleCount).map(service => <article key={service.publicId}>
            <div><small>{categoryLabel(service.category)} · {workAreaLabel(service)}</small><h5>{service.name}</h5>{service.summary && <p>{service.summary}</p>}</div>
            <label className="portal-library-select"><input type="checkbox" checked={selectedIds.has(service.publicId)} disabled={!selectedIds.has(service.publicId) && selected.length >= 10}
              onChange={event => event.target.checked ? onSelect(service) : onRemove(service)} />{selectedIds.has(service.publicId) ? "Selected: " : "Select "}{service.name}</label>
          </article>)}</div>
          {services.length > visibleCount && <button type="button" className="button-ghost" onClick={() => setVisibleCount(count => count + 24)}>Show more services</button>}
        </>)}
      {pageError && <div className="portal-inline-error" role="alert"><p>{pageError}</p></div>}
      {hasMore && <button type="button" className="button-ghost" aria-disabled={loadingMore} onClick={() => { if (!loadingMore) onLoadMore(); }}>{loadingMore ? "Loading more services…" : pageError ? "Retry loading more services" : "Load more services"}</button>}
    </div>
    <section id="selected-request-services" className="portal-library-selected" aria-labelledby="selected-request-services-title">
      <h4 id="selected-request-services-title">Selected services</h4>
      <p>Selections and answers stay here while you browse other categories. Removing a service also removes its answers.</p>
      {!selected.length && <p>No services selected yet.</p>}
      {selected.length >= 10 && <p role="status">You have selected the maximum of 10 services. Remove one to select another.</p>}
      {selected.map(service => {
        const current = catalog.find(item => item.publicId === service.publicId);
        const changed = state === "ready" && current && current.sourceVersion !== service.sourceVersion;
        const unpublished = state === "ready" && complete && !current;
        const unverified = state === "ready" && !complete && !current;
        return <article key={service.publicId} className={changed || unpublished ? "is-stale" : undefined}>
          <header><div><h5>{service.name}</h5><small>{categoryLabel(service.category)} · {workAreaLabel(service)}</small></div>
            <button type="button" className="button-ghost" aria-label={`Remove ${service.name}`} onClick={() => onRemove(service)}>Remove</button></header>
          {changed && <div className="portal-service-version-warning" role="alert"><strong>This service changed in Project Alpha.</strong><p>Your saved answers still use the prior version. Nothing was replaced automatically. Using the current version clears this service’s answers so you can review its current questions.</p><button type="button" className="button-ghost" onClick={() => onUseCurrent(current)}>Use current service version</button></div>}
          {unpublished && <div className="portal-service-version-warning" role="alert"><strong>This service is no longer available in the current library.</strong><p>Your saved selection and answers are preserved. Remove this service or ask your team about its availability before continuing.</p></div>}
          {unverified && <p>This saved service is not in the loaded services yet. Its availability has not been verified. Your selection and answers are preserved.</p>}
          {renderQuestions(service)}
        </article>;
      })}
    </section>
  </div>;
}
