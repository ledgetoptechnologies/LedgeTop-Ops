import type { NavigationDestination } from "@ltds/shared";

export function NavigationActions({
  destination,
}: {
  destination: NavigationDestination | null;
}) {
  if (!destination) return null;
  return (
    <section className="navigation-actions" aria-label="External navigation">
      <div>
        <strong>Navigate to area</strong>
        <small>
          {destination.label} · {destination.latitude.toFixed(6)}, {destination.longitude.toFixed(6)}
        </small>
      </div>
      <div className="navigation-action-buttons">
        <a
          className="button-orange button-small"
          href={destination.googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Maps
        </a>
        <a
          className="button-ghost button-small"
          href={destination.appleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Apple Maps
        </a>
      </div>
      <small>
        Destination is a representative point, not a guaranteed road or safe launch location.
      </small>
    </section>
  );
}
