import { Brand } from "@ltds/ui";

/** This is deliberately not DeliveryApp: `/client-share` must never fall
 * through to staff-created `/s` session or API behavior. */
export function ClientShareUnavailable() {
  return (
    <main className="shell gate-shell" data-client-share-unavailable>
      <Brand product="Client Share" />
      <section className="panel gate-card" aria-labelledby="client-share-title">
        <p className="eyebrow">Client-shared delivery</p>
        <h1 id="client-share-title">This client share link is not available yet</h1>
        <p>
          Client-created public links are currently disabled. Ask your Ledge Top
          Drone Services contact for an authorized delivery link.
        </p>
      </section>
    </main>
  );
}
