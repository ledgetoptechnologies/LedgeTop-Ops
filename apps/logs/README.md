# @ltds/logs: OpenDroneLog backup import

Reads an OpenDroneLog (ODL) backup and turns it into Ledge Top flight-log records. This package is a
library plus a local dry-run tool. It has no Worker, database, storage or network code; the logs service
(logs.ledgetop.app) consumes these records.

Design notes live on the Engineering Hub (project `ledge-top-ops`):
`logs/odl-backup-import-mapping-20261111.md` and `logs/raw-log-collection-sync-20261111.md`.

## What an ODL backup is

The `*.db.backup` file is **not** a database. It is a gzip-compressed tar of Parquet tables written by
DuckDB: flights, telemetry, flight_messages, flight_tags, flight_customizations, keychains,
equipment_names and settings. It holds ODL's parsed data only, **not** the original DJI `.txt` logs.

## Dry run

```
npm ci
node scripts/odl-dry-run.mjs <backup file> --pilot <pilot id> [--json] [--existing existing.json]
```

- Prints what an import would create: flights (new vs already imported), hours, date range, aircraft,
  batteries and controllers (matched vs new), telemetry, messages, tags and raw-log coverage.
- It writes nothing and contacts nothing. Serials are masked to their last four characters, and
  decryption keys are never read for the report.
- `--existing` takes a JSON file `{ fileHashes, aircraftSerials, batterySerials, controllerSerials }`
  describing what the logs service already holds, so re-importing a newer backup counts only new flights.
- The exit code is 0 when the backup is importable and 1 otherwise.

## Library

```js
import { openOdlBackup, dryRun, buildImport, streamTelemetry } from './src/odl/index.mjs';

const backup = openOdlBackup(bytes);              // throws OdlBackupError(code) for unreadable files
backup.validation;                                // { errors, warnings }: layout check, plain wording
const plan = await buildImport(backup, { pilot: { id } });
for await (const track of streamTelemetry(backup, { flightIds })) { /* one flight's columns */ }
const keys = await backup.keychains();            // [{ fileHash, key: SecretValue, fetchedAt }]
```

## Record contract `ltds.logs.odl-import.v1`

- **Units** are ODL's own: metres, metres per second, seconds, and UTC ISO timestamps.
- **Pilot is always explicit.** ODL has no pilot field, so one backup belongs to one pilot account.
  Every flight carries `pilot: { id, attribution: 'backup_owner' }`. Kollin's own ODL account is
  imported as a separate backup with his pilot id.
- **Staff only:** `visibility: 'staff'`. Flight logs are never shown to clients.
- **Identity:** `source.fileHash` (ODL's log fingerprint) is the natural key. A duplicate fingerprint
  in one backup is imported once and listed in `duplicateFlightIds`.
- **Flight fields:**
  - `source { system, flightId, fileHash, fileName, importedAtSource }`;
  - `displayName`, `startedAt`, `endedAt`, `durationSeconds`, `distanceMeters`, `maxAltitudeMeters`,
    `maxSpeedMetersPerSecond`;
  - `home { latitude, longitude } | null`, where 0,0 means none;
  - `aircraft { serial, model, name }`, with the model filled from the same aircraft when ODL left it
    blank;
  - `batterySerial`, `controllerSerial`, `battery { cycleCount, lifePercent }`;
  - `media { photos, videos }`, `telemetryPointCount`, `notes`, `color`;
  - `tags [{ tag, kind: 'auto'|'manual' }]`;
  - `rawLog { status: 'missing', keychainAvailable }`.
- **Customizations** (renames, notes, colours, manual tags) are already applied.
- **Equipment:** `{ aircraft, batteries, controllers }`, each `{ serial, flights, seconds, firstFlightAt,
  lastFlightAt, ... }`. Aircraft also carry model and name; batteries carry `maxCycleCount`.
- **Messages:** `{ sourceFlightId, offsetMs, level: 'tip'|'caution'|'warn', text }`.
- **Telemetry** is streamed one flight at a time as columns keyed by the names in `TELEMETRY_COLUMNS`.
  `offsetMs` is milliseconds from the flight start. Columns the backup lacks are omitted. Telemetry that
  isn't grouped by flight is refused (`telemetry_unordered`) rather than half-imported.
- **Keychains** are wrapped in `SecretValue`: the value is reachable only through `reveal()`, and JSON,
  string conversion and console output all print `[redacted]`. Per Beau's decision, they are stored
  encrypted and readable only by the log parser.

## Tests

`npm test` runs the tests, which build synthetic backups in memory. No real flight data is committed.
