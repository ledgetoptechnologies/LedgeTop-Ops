import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertStageOwnerAdoptionSourceMigrations, readStageOwnerAdoptionSourceMigrations, STAGE_OWNER_ADOPTION_MIGRATIONS,
} from '../stage-owner-native-adoption.mjs';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const sourceMigrations = path.resolve(scripts, '../apps/operations/migrations');
const prefix = 'ltds-historical-ops-0244-';

// Copy only the exact frozen prefix. The unchanged runtime verifies its
// count, final name, ordered name digest and byte digest against its pin.
export function historicalOperations0244Fixture() {
  const temp = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(temp, prefix));
  const migrations = path.join(root, 'apps', 'operations', 'migrations');
  const cleanup = () => {
    if (!existsSync(root)) return;
    assert.equal(path.dirname(realpathSync(root)), temp);
    assert.ok(path.basename(root).startsWith(prefix) && !lstatSync(root).isSymbolicLink());
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const current = readStageOwnerAdoptionSourceMigrations(sourceMigrations);
    mkdirSync(migrations, { recursive: true });
    for (const name of current.names.slice(0, STAGE_OWNER_ADOPTION_MIGRATIONS.count)) {
      copyFileSync(path.join(sourceMigrations, name), path.join(migrations, name));
    }
    const source = assertStageOwnerAdoptionSourceMigrations(readStageOwnerAdoptionSourceMigrations(migrations));
    return { root, migrations, source, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Load unchanged code relative to the frozen fixture, so the ordinary
// source guard remains active throughout every snapshot and execution.
export function loadHistoricalStageOwnerAdoption(fixture) {
  try {
    const destination = path.join(fixture.root, 'scripts');
    mkdirSync(destination);
    for (const name of ['stage-owner-native-adoption.mjs', 'native-staff-bootstrap-d1.mjs']) {
      copyFileSync(path.join(scripts, name), path.join(destination, name));
    }
    return createRequire(import.meta.url)(path.join(destination, 'stage-owner-native-adoption.mjs'));
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}
