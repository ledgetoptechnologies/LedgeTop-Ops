// A small initials badge so whose flights you're looking at is recognisable at a glance. The colour is
// derived from the pilot's ID, so the same person always gets the same colour across the page.
const COLORS = ["#cc4706", "#1a4fa3", "#17713e", "#7c3aed", "#9c2735", "#0f766e", "#7a5a00", "#3b4652"];

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts.at(-1)![0]}`).toUpperCase();
}

export function pilotColor(id: string | null | undefined): string {
  let hash = 0;
  for (const char of id ?? "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export function PilotAvatar({ id, name, size = "md" }: { id?: string | null; name: string | null | undefined; size?: "sm" | "md" | "lg" }) {
  return <span className={`flight-avatar ${size}`} style={{ background: pilotColor(id ?? name) }} aria-hidden="true">{initials(name)}</span>;
}

/** The "everyone" badge used when a manager is viewing every pilot's flights. */
export function AllPilotsAvatar({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return <span className={`flight-avatar all ${size}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" /><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><circle cx="17" cy="9" r="2.6" /><path d="M16 13.6c2.9.2 5 2.2 5 5.4" />
    </svg>
  </span>;
}
