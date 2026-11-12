// Types for the browser entry of the OpenDroneLog importer (browser.mjs).

export interface ParquetReader {
  parquetMetadata: (buffer: ArrayBuffer) => unknown;
  parquetSchema: (metadata: unknown) => { children: Array<{ element: { name: string } }> };
  parquetReadObjects: (options: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  compressors?: unknown;
}

export class OdlBackupError extends Error { code: string; }

export interface SecretValue { reveal(): string; }
export interface OdlBackup {
  ok: boolean;
  validation: { errors: string[]; warnings: string[] };
  summary(): Array<{ name: string; rows: number }>;
  keychains(): Promise<Array<{ fileHash: string; key: SecretValue; fetchedAt: string | null }>>;
}

export interface ImportFlight {
  schema: string;
  source: { system: 'opendronelog'; flightId: string; fileHash: string | null; fileName: string | null; importedAtSource: string | null };
  pilot: { id: string; attribution: 'backup_owner' };
  displayName: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  aircraft: { serial: string | null; model: string | null; name: string | null };
  [key: string]: unknown;
}
export interface ImportMessage { sourceFlightId: string; offsetMs: number | null; level: 'tip' | 'caution' | 'warn'; text: string }
export interface ImportPlan {
  schema: string;
  pilot: { id: string; attribution: 'backup_owner' };
  flights: ImportFlight[];
  messages: ImportMessage[];
  keychainCount: number;
  duplicates: Array<{ flightId: string; duplicateOf: string; reason: 'same_file' | 'same_aircraft_and_start' }>;
  duplicateFlightIds: string[];
}
export interface Existing { fileHashes?: string[]; aircraftSerials?: string[]; batterySerials?: string[]; controllerSerials?: string[]; flightStarts?: Array<[string, string]> }
interface EquipmentGroup { total: number; matched: number; new: number; items: Array<{ serial: string | null; flights: number; hours: number; model?: string | null; name?: string | null; maxCycleCount?: number | null; existing: boolean }> }
export interface DryRunReport {
  schema: string;
  pilot: { id: string } | null;
  files: Array<{ name: string; rows: number }>;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  flights?: { total: number; new: number; alreadyImported: number; firstFlightAt: string | null; lastFlightAt: string | null; hours: number; withoutAircraftSerial: number };
  equipment?: { aircraft: EquipmentGroup; batteries: EquipmentGroup; controllers: EquipmentGroup };
  telemetry?: { rows: number; flightsWithTrack: number; flightsWithoutTrack: number; ordered: boolean };
  messages?: { total: number; byLevel: Record<string, number> };
  rawLogCoverage?: { rawLogsInBackup: number; flightsWithKeychain: number; flightsNeedingRawLog: number };
  keychains?: { count: number; note: string };
}
export interface TelemetryTrack { sourceFlightId: string; rowCount: number; columns: Record<string, unknown[]> }

export const IMPORT_SCHEMA: string;
export const DRY_RUN_SCHEMA: string;
export function openOdlBackupInBrowser(input: Blob | Uint8Array | ArrayBuffer, parquet: ParquetReader): Promise<OdlBackup>;
export function dryRun(backup: OdlBackup, options: { pilot?: { id: string } | null; existing?: Existing }): Promise<DryRunReport>;
export function buildImport(backup: OdlBackup, options: { pilot: { id: string } }): Promise<ImportPlan>;
export function streamTelemetry(backup: OdlBackup, options?: { flightIds?: Set<string> }): AsyncGenerator<TelemetryTrack>;
