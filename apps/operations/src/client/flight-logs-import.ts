// Browser side of the OpenDroneLog import: the backup is read locally (it never leaves the browser
// as a file); only flight records, messages, sealed-at-rest keys and compressed tracks are sent.
import { answerLost, operationKey, settleOperation } from "./flight-logs/operation-keys";
import { parquetMetadata, parquetSchema, parquetReadObjects } from "hyparquet";
import { decompress as decompressZstd } from "fzstd";
import {
  buildImport, dryRun, openOdlBackupInBrowser, streamTelemetry,
  type DryRunReport, type Existing, type ImportPlan, type OdlBackup, type ParquetReader,
} from "../../../logs/src/odl/browser.mjs";
import { api } from "./api";

// OpenDroneLog (DuckDB) writes ZSTD; SNAPPY is decoded by hyparquet itself. Both are plain JavaScript, so
// nothing here needs WebAssembly, which the Operations Content-Security-Policy does not allow.
const compressors = { ZSTD: (input: Uint8Array) => decompressZstd(input) };
const PARQUET = { parquetMetadata, parquetSchema, parquetReadObjects, compressors } as unknown as ParquetReader;
/**
 * Small requests keep each Logs call's CPU time bounded (a 50-flight, ~4 MB batch ran a real import out of CPU
 * time). A flight bigger than BATCH_BYTES on its own (a busy flight can carry ~1.5 MB of messages) is sent alone;
 * one over the Ops route's limit (FLIGHT_LOG_LIMITS.batchBytes) stops the import before anything is written.
 */
export const FLIGHTS_PER_BATCH = 20;
export const BATCH_BYTES = 1024 * 1024;
export const OPS_BATCH_BYTES = 8 * 1024 * 1024;
const TRACK_CONCURRENCY = 3;

export interface ImportProgress { phase: "flights" | "tracks" | "done"; done: number; total: number }
export interface ImportOutcome { importId: string; flightsCreated: number; flightsResumed: number; flightsExisting: number; tracksStored: number; expectedFlights: number; messagesDropped: number }

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

/**
 * Runs the import. Re-running after a failure is safe: stored flights are not written again, and flights an
 * unfinished run stored without their track are resumed here so their track is sent. The server only
 * marks the import complete once every flight and every sent track is stored.
 */
export async function runImport(backup: OdlBackup, pilotId: string, onProgress: (progress: ImportProgress) => void, signal: AbortSignal): Promise<ImportOutcome> {
  const plan: ImportPlan = await buildImport(backup, { pilot: { id: pilotId } });
  const keys = new Map((await backup.keychains()).map(item => [item.fileHash, item]));
  // Every request body is measured before anything is written, so a flight too large to send stops the import
  // up front instead of failing partway. The same batches are then rebuilt one at a time while sending.
  const messagesByFlight = groupMessages(plan.messages);
  preflightBatches(plan, messagesByFlight, keys, signal);
  // A retry of this same start (after a lost answer) reuses its key; a definite answer settles it.
  const startAction = `import-start:${pilotId}:${plan.flights.length}`;
  let importId: string;
  try {
    ({ importId } = await api<{ importId: string }>("/api/admin/flight-logs/imports", {
      method: "POST", body: JSON.stringify({ pilotId, expectedFlights: plan.flights.length }), signal,
      headers: { "Idempotency-Key": operationKey(startAction) },
    }));
    settleOperation(startAction);
  } catch (error) {
    if (!answerLost(error)) settleOperation(startAction);
    throw error;
  }
  const base = `/api/admin/flight-logs/imports/${encodeURIComponent(importId)}`;

  // ODL flight id -> stored flight id, for flights this run stores or resumes (they take a track).
  const created = new Map<string, string>();
  let sent = 0, messagesDropped = 0;
  for (const batch of batches(plan, messagesByFlight, keys)) {
    signal.throwIfAborted();
    type Stored = Array<{ sourceFlightId: string; flightId: string }>;
    const result = await api<{ created: Stored; resumed?: Stored; messagesDropped?: number }>(`${base}/flights`, { method: "POST", body: batch.body, signal });
    for (const item of [...result.created, ...(result.resumed ?? [])]) created.set(item.sourceFlightId, item.flightId);
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
  const outcome = await api<Omit<ImportOutcome, "messagesDropped">>(`${base}/complete`, { method: "POST", body: JSON.stringify({ tracksExpected: stored }), signal });
  onProgress({ phase: "done", done: created.size, total: created.size });
  return { ...outcome, messagesDropped };
}

/** Messages by ODL flight id, in backup order (one pass). */
export function groupMessages(messages: ImportPlan["messages"]): Map<string, ImportPlan["messages"]> {
  const grouped = new Map<string, ImportPlan["messages"]>();
  for (const message of messages) {
    const list = grouped.get(message.sourceFlightId);
    if (list) list.push(message); else grouped.set(message.sourceFlightId, [message]);
  }
  return grouped;
}

export class FlightTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`One flight in this backup is too large to import (${(bytes / 1024 / 1024).toFixed(1)} MB of flight details; the limit is ${OPS_BATCH_BYTES / 1024 / 1024} MB). Nothing was imported.`);
    this.name = "FlightTooLargeError";
  }
}

/**
 * Checks, before anything is sent, that every request body fits the Ops route's limit. Bodies are built one at a
 * time and dropped after measuring, so a large archive never holds all of them in memory at once.
 */
export function preflightBatches(plan: Parameters<typeof batches>[0], messagesByFlight: Parameters<typeof batches>[1], keys: Parameters<typeof batches>[2], signal?: AbortSignal): number {
  const encoder = new TextEncoder();
  let count = 0;
  for (const batch of batches(plan, messagesByFlight, keys)) {
    signal?.throwIfAborted();
    const bytes = encoder.encode(batch.body).byteLength;
    if (bytes > OPS_BATCH_BYTES) throw new FlightTooLargeError(bytes);
    count++;
  }
  return count;
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
    current.flights.push(flight); for (const message of messages) current.messages.push(message); current.keychains.push(...keychains); size += weight;
  }
  if (current.flights.length) yield flush();
}
