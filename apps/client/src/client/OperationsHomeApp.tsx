import type { PortalOperationsHomeResponse } from "./portal-api";

export function OperationsHomeApp({ response }: { response: PortalOperationsHomeResponse }) {
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
      {response.homes.length === 0
        ? <section className="portal-card" aria-label="Available services"><h2>No services available</h2><p>Your account has no active operations services.</p></section>
        : response.homes.map((home, homeIndex) => <section className="portal-card" aria-labelledby={`operations-home-${homeIndex}`} key={home.authorityId}>
          <h2 id={`operations-home-${homeIndex}`}>Available services</h2>
          {home.services.length === 0
            ? <p>No services are currently listed for this access.</p>
            : <ul className="operations-home-services">
              {home.services.map(service => <li key={service.serviceId}><strong>{service.displayLabel}</strong></li>)}
            </ul>}
        </section>)}
    </main>
  </div>;
}
