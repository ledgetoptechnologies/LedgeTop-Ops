/**
 * Pure D1 migration classifier for automatic application (Hub 88b8546f, plan PR 2). It never touches production:
 * it replays the source migrations in order into a private in-memory SQLite database (node:sqlite) and classifies
 * each file by three independent checks that must all agree before a file counts as automatically applicable:
 *
 *  1. Token check: every statement (split exactly as Wrangler sends it) starts with an allowed additive form.
 *  2. SQLite authorizer: the actions SQLite itself reports while executing the file are all additive actions on
 *     allowed objects.
 *  3. Schema diff: sqlite_master and the column lists before and after show only new objects and appended, nullable
 *     (or defaulted) columns; nothing earlier was removed or rewritten.
 *
 * Additive: CREATE TABLE (new name), CREATE INDEX (non-unique; unique only on a table created in the same file),
 * CREATE VIEW (new name), ALTER TABLE ... ADD COLUMN (nullable or with a default), INSERT ... VALUES only into a
 * table created in the same file. Everything else needs review: DROP/RENAME, UPDATE/DELETE/REPLACE/upsert,
 * INSERT into an existing table, any trigger (a trigger body's writes are only authorized when it later fires),
 * PRAGMA/ATTACH/VACUUM/REINDEX/transactions, writes to d1_migrations, sqlite_ or _cf_ objects, and anything unknown.
 * Permission-changing: any action on a table whose name matches PERMISSION_TABLE_PATTERN, including creating one.
 * A file is applied automatically only if it is additive and not permission-changing.
 */
import { DatabaseSync, constants as C } from 'node:sqlite';

export const MIGRATION_CLASSIFIER_VERSION = 1;
export const PERMISSION_TABLE_PATTERN = /(^|_)(permissions?|roles?|staff|delegations?|grants?|shares?|shared|acl|authority|authorities|authorizations?|members?|memberships?|admissions?|capabilities|ceilings|bindings?)(_|$)/u;
const SETUP = /^PRAGMA\s+defer_foreign_keys\s*=\s*(?:on|off|true|false|1|0)\s*;?\s*$/iu;
const RESERVED = /^(?:d1_migrations|sqlite_.*|_cf_.*)$/iu;
const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;
const FORMS = Object.freeze([
  ['create-trigger', new RegExp(String.raw`^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s+(?:BEFORE|AFTER|INSTEAD\s+OF)?\s*(?:INSERT|DELETE|UPDATE(?:\s+OF\s+[^]+?)?)\s+ON\s+${QUALIFIED}\s`, 'iu')],
  // Most files open with this; D1 already enforces foreign keys, so it changes nothing.
  ['foreign-keys-on', /^PRAGMA\s+foreign_keys\s*=\s*(?:ON|1|TRUE)\s*;?$/iu],
  ['create-table', new RegExp(String.raw`^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s*\(`, 'iu')],
  ['create-index', new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s+ON\s+${QUALIFIED}\s*\(`, 'iu')],
  ['create-view', new RegExp(String.raw`^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s+AS\s+SELECT\b`, 'iu')],
  ['add-column', new RegExp(String.raw`^ALTER\s+TABLE\s+${QUALIFIED}\s+ADD\s+(?:COLUMN\s+)?${IDENT}`, 'iu')],
  ['insert-values', new RegExp(String.raw`^INSERT\s+INTO\s+${QUALIFIED}\s*(?:\([^)]*\)\s*)?VALUES\b`, 'iu')],
]);
// A guard trigger: on a table created in the same file, and its body only reads/raises (no writes anywhere).
// Text between BEGIN and the final END; any write keyword in it (even inside a message) needs review.
function guardTriggerBody(sql) {
  const text = stripComments(String(sql ?? ''));
  const start = text.search(/\bBEGIN\b/iu), end = text.search(/\bEND\s*;?\s*$/iu);
  if (start < 0 || end <= start) return false;
  return !/\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|PRAGMA|ATTACH)\b/iu.test(text.slice(start + 5, end));
}
const unquote = value => {
  const v = value.trim();
  if (/^".*"$/su.test(v)) return v.slice(1, -1).replaceAll('""', '"');
  if (/^\x60.*\x60$/su.test(v)) return v.slice(1, -1).replaceAll('\x60\x60', '\x60');
  if (/^\[.*\]$/su.test(v)) return v.slice(1, -1);
  return v;
};
const stripComments = sql => sql.replace(/--[^\n]*\n?/gu, '\n').replace(/\/\*[\s\S]*?\*\//gu, ' ').trim();
const SCHEMA = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name <> 'd1_migrations' ORDER BY type,name";
// SQLite authorizer action codes (https://www.sqlite.org/c3ref/c_alter_table.html). Listed explicitly: other
// SQLITE_* constant families reuse the same small integers.
const ACTIONS = Object.freeze(['COPY', 'CREATE_INDEX', 'CREATE_TABLE', 'CREATE_TEMP_INDEX', 'CREATE_TEMP_TABLE',
  'CREATE_TEMP_TRIGGER', 'CREATE_TEMP_VIEW', 'CREATE_TRIGGER', 'CREATE_VIEW', 'DELETE', 'DROP_INDEX', 'DROP_TABLE',
  'DROP_TEMP_INDEX', 'DROP_TEMP_TABLE', 'DROP_TEMP_TRIGGER', 'DROP_TEMP_VIEW', 'DROP_TRIGGER', 'DROP_VIEW', 'INSERT',
  'PRAGMA', 'READ', 'SELECT', 'TRANSACTION', 'UPDATE', 'ATTACH', 'DETACH', 'ALTER_TABLE', 'REINDEX', 'ANALYZE',
  'CREATE_VTABLE', 'DROP_VTABLE', 'FUNCTION', 'SAVEPOINT', 'RECURSIVE']);
// Actions that may appear while executing an additive statement (reads of schema/existing data are harmless).
const INCIDENTAL = new Set(['READ', 'SELECT', 'FUNCTION', 'RECURSIVE']);

function tokenForm(statement) {
  const text = stripComments(statement);
  for (const [form, pattern] of FORMS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (form === 'foreign-keys-on') return { form };
    if (form === 'create-trigger') return { form, object: unquote(match[1]), table: unquote(match[2]) };
    if (form === 'create-table') {
      if (match[1] || /\)\s*AS\s+SELECT\b/iu.test(text) || /^CREATE\s+TABLE\b[^(]*\bAS\s+SELECT\b/iu.test(text)) return { form: 'unknown' };
      return { form, object: unquote(match[2]) };
    }
    if (form === 'create-index') return { form, unique: Boolean(match[1]), object: unquote(match[2]), table: unquote(match[3]) };
    if (form === 'create-view') return { form, object: unquote(match[1]) };
    if (form === 'add-column') {
      if (/\bADD\s+(?:COLUMN\s+)?\S+[\s\S]*\b(?:PRIMARY\s+KEY|UNIQUE)\b/iu.test(text)) return { form: 'unknown' };
      return { form, table: unquote(match[1]) };
    }
    if (form === 'insert-values') {
      if (/\bON\s+CONFLICT\b|\bRETURNING\b/iu.test(text)) return { form: 'unknown' };
      return { form, table: unquote(match[1]) };
    }
  }
  return { form: 'unknown' };
}

function schemaRows(db) { return db.prepare(SCHEMA).all().map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql })); }
function columns(db, table) {
  return db.prepare('SELECT name,type,"notnull" AS not_null,dflt_value,pk FROM pragma_table_info(?)').all(table)
    .map(row => ({ name: row.name, type: row.type, notnull: row.not_null, dflt_value: row.dflt_value, pk: row.pk }));
}

/** Statements exactly as Wrangler would send them, without its foreign-key setup PRAGMA. */
export function migrationStatements(sql, split) {
  if (typeof sql !== 'string' || typeof split !== 'function') throw new Error('migration_classifier_input_invalid');
  const statements = split(sql).filter(statement => !SETUP.test(String(statement).trim()));
  if (statements.some(statement => typeof statement !== 'string' || statement.trim().length === 0)) throw new Error('migration_classifier_statement_invalid');
  return statements;
}

function classifyOne(db, { name, sql }, split) {
  const reasons = new Set(), permissionTables = new Set();
  const created = { tables: new Set(), indexes: new Set(), views: new Set() }, altered = new Set(), seeded = new Set();
  let statements;
  try { statements = migrationStatements(sql, split); } catch { reasons.add('unparseable'); statements = []; }
  if (statements.length === 0) reasons.add('empty');
  const forms = statements.map(tokenForm);
  forms.forEach((form, i) => { if (form.form === 'unknown') reasons.add(`statement_${i + 1}_not_additive_form`); });
  for (const form of forms) for (const table of [form.object, form.table].filter(Boolean)) {
    if (RESERVED.test(table)) reasons.add('reserved_object');
  }
  const before = schemaRows(db), beforeNames = new Set(before.map(row => row.name.toLowerCase()));
  const beforeTables = new Set(before.filter(row => row.type === 'table').map(row => row.name.toLowerCase()));
  const beforeColumns = new Map([...beforeTables].map(table => [table, columns(db, table)]));
  const actions = [];
  let executed = false;
  db.exec('SAVEPOINT classify');
  try {
    db.setAuthorizer((action, a1, a2, dbName, inner) => {
      actions.push({ action: ACTIONS[action] ?? `CODE_${action}`, a1: a1 ?? null, a2: a2 ?? null, inner: inner ?? null });
      return C.SQLITE_OK;
    });
    try { for (const statement of statements) db.exec(statement); executed = true; }
    finally { db.setAuthorizer(null); }
  } catch { reasons.add('replay_failed'); db.exec('ROLLBACK TO classify'); }
  db.exec('RELEASE classify');
  // The file's own creations, used to scope same-file rules.
  for (const form of forms) {
    if (form.form === 'create-table') created.tables.add(form.object.toLowerCase());
    if (form.form === 'create-index') created.indexes.add(form.object.toLowerCase());
    if (form.form === 'create-view') created.views.add(form.object.toLowerCase());
  }
  // Authorizer: every reported action must be additive on an allowed object.
  for (const { action, a1, a2, inner } of actions) {
    const table = String(a1 ?? '').toLowerCase();
    if (INCIDENTAL.has(action)) continue;
    // Any write or schema action on a permission-type table makes the file permission-changing, whatever else it is.
    if (['INSERT', 'UPDATE', 'DELETE', 'ALTER_TABLE', 'DROP_TABLE', 'CREATE_TABLE'].includes(action)) {
      const target = String(action === 'ALTER_TABLE' ? a2 ?? '' : a1 ?? '').toLowerCase();
      if (PERMISSION_TABLE_PATTERN.test(target)) permissionTables.add(target);
    }
    if (action === 'CREATE_TABLE') { if (beforeNames.has(table)) reasons.add('create_existing_table'); else if (RESERVED.test(table)) reasons.add('reserved_object'); continue; }
    if (action === 'CREATE_INDEX') {
      const indexed = String(a2 ?? '').toLowerCase();
      const form = forms.find(f => f.form === 'create-index' && f.object.toLowerCase() === table);
      if (beforeNames.has(table)) reasons.add('create_existing_index');
      if (form?.unique && !created.tables.has(indexed)) reasons.add('unique_index_on_existing_table');
      if (PERMISSION_TABLE_PATTERN.test(indexed)) permissionTables.add(indexed);
      continue;
    }
    // SQLite reports its own population of an index it is creating in this file as REINDEX of that index.
    if (action === 'REINDEX' && created.indexes.has(table)) continue;
    if (action === 'PRAGMA' && table === 'foreign_keys' && /^(?:on|1|true)$/iu.test(String(a2 ?? ''))) continue;
    if (action === 'CREATE_TRIGGER') {
      const on = String(a2 ?? '').toLowerCase();
      if (!created.tables.has(on)) reasons.add('trigger_on_existing_table');
      if (PERMISSION_TABLE_PATTERN.test(on)) permissionTables.add(on);
      continue;
    }
    if (action === 'CREATE_VIEW') { if (beforeNames.has(table)) reasons.add('create_existing_view'); continue; }
    if (action === 'ALTER_TABLE') { altered.add(String(a2 ?? '').toLowerCase()); continue; }
    if (action === 'INSERT') {
      // Creating a table also inserts its sqlite_master row: that is SQLite's own bookkeeping.
      if (table === 'sqlite_master' || table === 'sqlite_temp_master') continue;
      if (inner) { reasons.add('trigger_or_view_write'); continue; }
      if (!created.tables.has(table)) reasons.add('insert_into_existing_table'); else seeded.add(table);
      continue;
    }
    if (action === 'UPDATE' && (table === 'sqlite_master' || table === 'sqlite_temp_master')) continue;
    if (action === 'DELETE' && (table === 'sqlite_master' || table === 'sqlite_temp_master')) { reasons.add('schema_object_removed'); continue; }
    reasons.add(`action_${action.toLowerCase()}`);
  }
  // Schema diff: nothing earlier removed or rewritten except the column additions on altered tables.
  const after = schemaRows(db), afterByKey = new Map(after.map(row => [`${row.type}:${row.name.toLowerCase()}`, row]));
  for (const row of before) {
    const next = afterByKey.get(`${row.type}:${row.name.toLowerCase()}`);
    if (!next) { reasons.add('schema_object_removed'); continue; }
    if (next.sql !== row.sql && !(row.type === 'table' && altered.has(row.name.toLowerCase()))) reasons.add('schema_object_rewritten');
  }
  const beforeKeys = new Set(before.map(row => `${row.type}:${row.name.toLowerCase()}`));
  const added = after.filter(row => !beforeKeys.has(`${row.type}:${row.name.toLowerCase()}`));
  for (const row of added) {
    if (row.type === 'trigger' && !(created.tables.has(row.tbl_name.toLowerCase()) && guardTriggerBody(row.sql))) reasons.add('trigger_not_guard');
    else if (!['table', 'index', 'view', 'trigger'].includes(row.type)) reasons.add(`new_${row.type}`);
    if (row.type === 'table' && PERMISSION_TABLE_PATTERN.test(row.name.toLowerCase())) permissionTables.add(row.name.toLowerCase());
    if (row.type === 'index' && PERMISSION_TABLE_PATTERN.test(row.tbl_name.toLowerCase())) permissionTables.add(row.tbl_name.toLowerCase());
  }
  for (const table of altered) {
    if (!beforeTables.has(table)) { reasons.add('alter_unknown_table'); continue; }
    const prior = beforeColumns.get(table), now = columns(db, table);
    if (now.length <= prior.length || JSON.stringify(now.slice(0, prior.length)) !== JSON.stringify(prior)) { reasons.add('columns_changed'); continue; }
    for (const column of now.slice(prior.length)) if (column.pk || (column.notnull && column.dflt_value === null)) reasons.add('added_column_not_nullable_without_default');
    if (PERMISSION_TABLE_PATTERN.test(table)) permissionTables.add(table);
  }
  for (const table of seeded) if (PERMISSION_TABLE_PATTERN.test(table)) permissionTables.add(table);
  // Token forms that the authorizer/diff must corroborate.
  for (const form of forms) {
    if (form.form === 'add-column' && !altered.has(form.table.toLowerCase())) reasons.add('add_column_not_observed');
    if (form.form === 'insert-values' && !created.tables.has(form.table.toLowerCase())) reasons.add('insert_into_existing_table');
    if (form.form === 'create-table' && !added.some(row => row.type === 'table' && row.name.toLowerCase() === form.object.toLowerCase())) reasons.add('create_table_not_observed');
  }
  const additive = executed && reasons.size === 0;
  const permission = permissionTables.size > 0;
  return Object.freeze({
    name, additive, permission, automatic: additive && !permission,
    reasons: Object.freeze([...reasons].sort()), permissionTables: Object.freeze([...permissionTables].sort()),
  });
}

/**
 * Classify every file of one app's source migrations, in order, replaying each (whatever its class) so later files
 * see the schema they will meet in production. files: [{ name, sql }] in application order.
 */
export function classifyMigrationSequence({ files, split } = {}) {
  if (!Array.isArray(files) || typeof split !== 'function'
    || files.some(file => !file || typeof file.name !== 'string' || typeof file.sql !== 'string')) throw new Error('migration_classifier_input_invalid');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    return Object.freeze(files.map(file => classifyOne(db, file, split)));
  } finally { db.close(); }
}

/** Wrangler's own D1 statement splitter, from the Operations app's locked dependency (the one `d1 migrations apply`
 * uses), so classification sees exactly the statements D1 would receive. */
export async function loadWranglerMigrationSplitter(root) {
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const { unstable_splitSqlQuery } = createRequire(path.join(root, 'apps', 'operations', 'package.json'))('wrangler');
  if (typeof unstable_splitSqlQuery !== 'function') throw new Error('migration_classifier_splitter_unavailable');
  return unstable_splitSqlQuery;
}

/** One app's source migrations, in application order, as { name, sql }. */
export async function readSourceMigrations(root, app) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  if (!['operations', 'client'].includes(app)) throw new Error('migration_classifier_input_invalid');
  const dir = path.join(root, 'apps', app, 'migrations');
  return fs.readdirSync(dir).filter(name => /^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name)).sort()
    .map(name => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}
