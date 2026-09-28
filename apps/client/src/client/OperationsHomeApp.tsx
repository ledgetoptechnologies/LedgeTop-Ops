import type { PortalOperationsHomeResponse } from "./portal-api";

export function OperationsServiceSummary({ response, embedded = false }: {
  response: PortalOperationsHomeResponse;
  embedded?: boolean;
}) {
  return <section className="portal-card" aria-label="Independent operations service summary">
    <h2>{embedded ? "Operations services" : response.homes.length === 0 ? "No services available" : "Available services"}</h2>
    {embedded && <p>Your service summary. Files and requests follow the access for your selected workspace.</p>}
    {response.homes.length === 0
      ? <p>Your account has no active operations services.</p>
      : response.homes.map(home => <div key={home.authorityId}>
        {home.services.length === 0
          ? <p>No services are currently listed for this access.</p>
          : <ul className="operations-home-services">
            {home.services.map(service => <li key={service.serviceId}><strong>{service.displayLabel}</strong></li>)}
          </ul>}
      </div>)}
  </section>;
}

export function OperationsHomeApp({ response, clientUnavailable = false, onRetryClient }: {
  response: PortalOperationsHomeResponse;
  clientUnavailable?: boolean;
  onRetryClient?: () => void;
}) {
  return <div className="client-portal operations-home">
    <header className="client-portal-header">
      <div className="ltds-brand" aria-label="LedgeTop client portal">LedgeTop</div>
    </header>
    <main className="portal-main">
      <section className="portal-welcome">
        <p className="portal-eyebrow">LedgeTop client portal</p>
        <h1>Your services</h1>
        <p>Services currently available to you from LedgeTop operations providers.</p>
      </section>
      {clientUnavailable && <section className="portal-card" role="status">
        <h2>Client resources unavailable</h2>
        <p>Your Operations service summary is still available. You can retry without the unavailable workspace selection.</p>
        {onRetryClient && <button type="button" className="button-ghost" onClick={onRetryClient}>Try available client workspaces</button>}
      </section>}
      <OperationsServiceSummary response={response} />
    </main>
  </div>;
}
