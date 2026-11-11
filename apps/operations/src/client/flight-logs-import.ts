// Browser side of the OpenDroneLog import: the backup is read locally (it never leaves the browser
// as a file); only flight records, messages, sealed-at-rest keys and compressed tracks are sent.
import { parquetMetadata, parquetSchema, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  buildImport, dryRun, openOdlBackupInBrowser, streamTelemetry,
  type DryRunReport, type Existing, type ImportPlan, type OdlBackup, type ParquetReader,
} from "../../../logs/src/odl/browser.mjs";
import { api } from "./api";

const PARQUET = { parquetMetadata, parquetSchema, parquetReadObjects, compressors } as unknown as ParquetReader;
export const FLIGHTS_PER_BATCH = 50;
/** Kept well under the Ops route's 8 MB batch limit; a single busy flight can carry ~1.5 MB of messages. */
export const BATCH_BYTES = 4 * 1024 * 1024;
const TRACK_CONCURRENCY = 3;

export interface ImportProgress { phase: "flights" | "tracks" | "done"; done: number; total: number }
export interface ImportOutcome { importId: string; flightsCreated: number; flightsExisting: number; tracksStored: number; expectedFlights: number; messagesDropped: number }

export async function openBackup(file: File): Promise<OdlBackup> {
  return openOdlBackupInBrowser(file, PARQUET);
}

export async function previewBackup(backup: OdlBackup, pilotId: string | null): Promise<DryRunReport> {
  const existing = pilotId ? await api<Existing>("/api/admin/flight-logs/import/inventory") : {};
  return dryRun(backup, { pilot: pilotId ? { id: pilotId } : null, existing });
}

async function gzipJson(value: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** Runs the import. Re-running after a failure is safe: flights already stored are reported as existing. */
export async function runImport(backup: OdlBackup, pilotId: string, onProgress: (progress: ImportProgress) => void, signal: AbortSignal): Promise<ImportOutcome> {
  const plan: ImportPlan = await buildImport(backup, { pilot: { id: pilotId } });
  const keys = new Map((await backup.keychains()).map(item => [item.fileHash, item]));
  const { importId } = await api<{ importId: string }>("/api/admin/flight-logs/imports", {
    method: "POST", body: JSON.stringify({ pilotId, expectedFlights: plan.flights.length }), signal,
  });
  const base = `/api/admin/flight-logs/imports/${encodeURIComponent(importId)}`;
  const messagesByFlight = new Map<string, ImportPlan["messages"]>();
  for (const message of plan.messages) messagesByFlight.set(message.sourceFlightId, [...(messagesByFlight.get(message.sourceFlightId) ?? []), message]);

  const created = new Map<string, string>(); // ODL flight id -> stored flight id, only for new flights
  let sent = 0, messagesDropped = 0;
  for (const batch of batches(plan, messagesByFlight, keys)) {
    signal.throwIfAborted();
    const result = await api<{ created: Array<{ sourceFlightId: string; flightId: string }>; messagesDropped?: number }>(`${base}/flights`, { method: "POST", body: batch.body, signal });
    for (const item of result.created) created.set(item.sourceFlightId, item.flightId);
    messagesDropped += result.messagesDropped ?? 0;
    sent += batch.flights;
    onProgress({ phase: "flights", done: sent, total: plan.flights.length });
  }

  let stored = 0;
  const pending = new Set<Promise<void>>();
  onProgress({ phase: "tracks", done: 0, total: created.size });
  for await (const track of streamTelemetry(backup, { flightIds: new Set(created.keys()) })) {
    signal.throwIfAborted();
    const flightId = created.get(track.sourceFlightId);
    if (!flightId) continue;
    const upload = gzipJson({ schema: "ltds.logs.telemetry.v1", ...track })
      .then(body => api(`${base}/flights/${encodeURIComponent(flightId)}/track`, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" }, signal }))
      .then(() => { stored++; onProgress({ phase: "tracks", done: stored, total: created.size }); });
    const tracked = upload.finally(() => pending.delete(tracked));
    pending.add(tracked);
    if (pending.size >= TRACK_CONCURRENCY) await Promise.race(pending);
  }
  await Promise.all(pending);
  const outcome = await api<Omit<ImportOutcome, "messagesDropped">>(`${base}/complete`, { method: "POST", signal });
  onProgress({ phase: "done", done: created.size, total: created.size });
  return { ...outcome, messagesDropped };
}

/** Groups flights into request bodies of at most FLIGHTS_PER_BATCH flights and about BATCH_BYTES. */
export function* batches(plan: ImportPlan, messagesByFlight: Map<string, ImportPlan["messages"]>, keys: Map<string, { fileHash: string; key: { reveal(): string }; fetchedAt: string | null }>): Generator<{ body: string; flights: number }> {
  const encoder = new TextEncoder();
  let current: { flights: ImportPlan["flights"]; messages: ImportPlan["messages"]; keychains: Array<{ fileHash: string; key: string; fetchedAt: string | null }> } = { flights: [], messages: [], keychains: [] };
  let size = 0;
  const flush = () => { const body = JSON.stringify(current), flights = current.flights.length; current = { flights: [], messages: [], keychains: [] }; size = 0; return { body, flights }; };
  for (const flight of plan.flights) {
    const messages = messagesByFlight.get(flight.source.flightId) ?? [];
    const key = flight.source.fileHash ? keys.get(flight.source.fileHash) : undefined;
    const keychains = key ? [{ fileHash: key.fileHash, key: key.key.reveal(), fetchedAt: key.fetchedAt }] : [];
    const weight = encoder.encode(JSON.stringify({ flight, messages, keychains })).byteLength;
    if (current.flights.length && (current.flights.length >= FLIGHTS_PER_BATCH || size + weight > BATCH_BYTES)) yield flush();
    current.flights.push(flight); current.messages.push(...messages); current.keychains.push(...keychains); size += weight;
  }
  if (current.flights.length) yield flush();
}
