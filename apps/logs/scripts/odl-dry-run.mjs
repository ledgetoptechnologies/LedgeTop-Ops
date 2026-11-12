#!/usr/bin/env node
// Dry run of an OpenDroneLog backup import. Reads the file locally and prints what an import would
// create. It writes nothing, contacts nothing, masks serials and never prints decryption keys.
//
//   node scripts/odl-dry-run.mjs <backup file> --pilot <pilot id> [--json] [--existing existing.json]
import fs from 'node:fs';
import { openOdlBackup, dryRun, OdlBackupError } from '../src/odl/index.mjs';

function parse(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--pilot') options.pilot = argv[++i];
    else if (arg === '--existing') options.existing = argv[++i];
    else if (!options.file) options.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function print(report) {
  const out = [];
  out.push(`OpenDroneLog backup dry run (${report.schema})`);
  out.push(`Pilot: ${report.pilot?.id ?? '(not chosen)'}`);
  out.push(`Files: ${report.files.map(file => `${file.name} ${file.rows.toLocaleString()}`).join(', ')}`);
  for (const error of report.validation.errors) out.push(`ERROR  ${error}`);
  for (const warning of report.validation.warnings) out.push(`warn   ${warning}`);
  if (report.flights) {
    const f = report.flights;
    out.push(`Flights: ${f.total} (${f.new} new, ${f.alreadyImported} already imported), ${f.hours} h, ${f.firstFlightAt?.slice(0, 10)} to ${f.lastFlightAt?.slice(0, 10)}`);
    for (const [label, group] of Object.entries(report.equipment)) {
      out.push(`${label[0].toUpperCase()}${label.slice(1)}: ${group.total} (${group.matched} matched, ${group.new} new)`);
      for (const item of group.items.slice(0, 12)) out.push(`   ${item.serial} ${item.model ?? ''} ${item.name ?? ''} ${item.flights} flights ${item.hours} h${item.maxCycleCount ? ` ${item.maxCycleCount} cycles` : ''}`.replace(/\s+/g, ' '));
    }
    out.push(`Telemetry: ${report.telemetry.rows.toLocaleString()} points, ${report.telemetry.flightsWithTrack} flights with a track, ${report.telemetry.flightsWithoutTrack} without`);
    out.push(`Messages: ${report.messages.total} (${Object.entries(report.messages.byLevel).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    out.push(`Raw logs: none in the backup; ${report.rawLogCoverage.flightsWithKeychain} flights have a stored decryption key, ${report.keychains.count} keys total (values not shown)`);
  }
  out.push(report.validation.ok ? 'Ready to import. Nothing was written.' : 'Not importable as-is. Nothing was written.');
  return out.join('\n');
}

const options = parse(process.argv.slice(2));
if (!options.file) { console.error('Usage: node scripts/odl-dry-run.mjs <backup file> --pilot <pilot id> [--json] [--existing existing.json]'); process.exit(2); }
try {
  const existing = options.existing ? JSON.parse(fs.readFileSync(options.existing, 'utf8')) : {};
  const backup = openOdlBackup(fs.readFileSync(options.file));
  const report = await dryRun(backup, { pilot: options.pilot ? { id: options.pilot } : null, existing });
  console.log(options.json ? JSON.stringify(report, null, 2) : print(report));
  process.exit(report.validation.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof OdlBackupError ? `ERROR  ${error.message} (${error.code})` : error);
  process.exit(1);
}
