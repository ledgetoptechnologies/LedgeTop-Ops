import {
  CATEGORY_TEXT, SIGNIFICANCE_TEXT, confidenceBand, confidenceText, decimalMicros, percentText, scoreLevel, scoreMeaning, scoreNumber,
  type ChangeCategory, type ClientScore, type ConfidenceBand, type Freshness, type Probability, type Score, type Significance,
} from "@ltds/shared/competitor-intel";
import "./CompetitorIntelVisuals.css";

const LEVEL_CLASS = ["low", "mid", "high"] as const;

export function ciDate(value: string | null, withTime = false): string {
  if (!value) return "Never";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return date.toLocaleString(undefined, withTime
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" });
}

/** Staff scores carry numeric confidence; portal scores carry only a band. Both render the band. */
function band(score: Score | ClientScore): ConfidenceBand | null {
  const value = score.confidence;
  return value === "low" || value === "medium" || value === "high" ? value : confidenceBand(value);
}

export function ScoreMeter({ label, score, compact = false }: { label: string; score: Score | ClientScore; compact?: boolean }) {
  const observed = score.state === "observed" && score.value !== null;
  const level = observed ? LEVEL_CLASS[scoreLevel(score.value!)] : "none";
  const width = observed ? Math.max(2, Math.min(100, Number(decimalMicros(score.value!) / 100_000n))) : 0;
  const meaning = scoreMeaning(score);
  return <div className={`ci-meter ci-meter-${level}${compact ? " ci-meter-compact" : ""}`}>
    <div className="ci-meter-head">
      <span className="ci-meter-label">{label}</span>
      {observed && <strong className="ci-meter-value">{scoreNumber(score.value!)}<small>/10</small></strong>}
    </div>
    <div className="ci-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={10}
      aria-valuenow={observed ? Number(scoreNumber(score.value!)) : undefined} aria-valuetext={observed ? `${scoreNumber(score.value!)} of 10, ${meaning}` : meaning}>
      <span style={{ width: `${width}%` }} />
    </div>
    <div className="ci-meter-foot"><span>{meaning}</span>{observed && !compact && <span className="ci-muted">{confidenceText(band(score))}</span>}</div>
  </div>;
}

export function PercentDial({ label, probability }: { label: string; probability: Probability }) {
  const observed = probability.state === "observed" && probability.value !== null;
  const percent = observed ? Number((decimalMicros(probability.value!) + 5_000n) / 10_000n) : 0, text = percentText(probability);
  const radius = 26, circumference = 2 * Math.PI * radius;
  return <div className="ci-dial">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle className="ci-dial-track" cx="32" cy="32" r={radius} />
      {observed && <circle className="ci-dial-fill" cx="32" cy="32" r={radius} strokeDasharray={`${circumference * percent / 100} ${circumference}`} />}
      <text x="32" y="36" textAnchor="middle">{observed ? `${percent}%` : "—"}</text>
    </svg>
    <span><strong>{label}</strong><small>{observed ? "chance of serving the same area" : text}</small></span>
  </div>;
}

export function FreshnessTag({ freshness, at, label = "Updated" }: { freshness: Freshness; at: string | null; label?: string }) {
  return <span className={`ci-fresh ci-fresh-${freshness}`}>
    {!at ? (freshness === "stale" ? "Out of date · no result yet" : "No result yet")
      : freshness === "stale" ? `Out of date · ${label.toLowerCase()} ${ciDate(at)}` : `${label} ${ciDate(at)}`}
  </span>;
}

export function SignificanceBadge({ value }: { value: Significance | null }) {
  return <span className={`ci-sig ci-sig-${value ?? "none"}`}>{value ? SIGNIFICANCE_TEXT[value] : "Unrated"}</span>;
}

export function CategoryTag({ value }: { value: ChangeCategory | null }) {
  return value ? <span className="ci-tag">{CATEGORY_TEXT[value]}</span> : null;
}

/** Added and removed sentences, shown as a compact before/after list. */
export function SentenceDiff({ added, removed }: { added: string[]; removed: string[] }) {
  if (!added.length && !removed.length) return null;
  return <details className="ci-diff">
    <summary>What changed on the page ({added.length} added, {removed.length} removed)</summary>
    <ul>
      {added.map((text, index) => <li key={`a${index}`} className="ci-diff-add"><span aria-label="Added">+</span>{text}</li>)}
      {removed.map((text, index) => <li key={`r${index}`} className="ci-diff-remove"><span aria-label="Removed">−</span>{text}</li>)}
    </ul>
  </details>;
}
