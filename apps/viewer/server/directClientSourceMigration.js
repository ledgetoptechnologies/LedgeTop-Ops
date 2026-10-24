'use strict';

// Migration 17 deliberately allowed only model associations. Rebuild the three
// leaf tables transactionally instead of rewriting sqlite_master or weakening
// its existing immutable/complete-source triggers. The caller holds the normal
// migration write lock and commits the version receipt in the same transaction.
function migrateDirectClientSources(database) {
  const names = ['session_grants', 'viewer_sessions', 'revoked_published_session_authorizations'];
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    if (database.prepare(`PRAGMA foreign_key_list(${quoted})`).all().some(row => names.includes(row.table)))
      throw new Error('Direct client source migration requires reviewed leaf tables');
  }
  for (const name of names) {
    const original = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
    const check = /source_authorization_type\s*=\s*'model_association'/g;
    if (typeof original !== 'string' || [...original.matchAll(check)].length !== 1)
      throw new Error('Unexpected session source authorization schema');
    const definitions = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all(name);
    const temporary = `${name}_direct_client_migration`;
    const updated = original.replace(new RegExp(`^CREATE TABLE\\s+["\x60\\[]?${name}["\x60\\]]?`, 'i'), `CREATE TABLE "${temporary}"`)
      .replace(check, "source_authorization_type IN ('model_association','direct_client_grant')");
    if (updated === original || !updated.startsWith(`CREATE TABLE "${temporary}"`)) throw new Error('Unexpected session table declaration');
    const columns = database.prepare(`PRAGMA table_info("${name}")`).all().map(row => `"${row.name.replaceAll('"', '""')}"`).join(',');
    database.exec(updated);
    database.exec(`INSERT INTO "${temporary}" (${columns}) SELECT ${columns} FROM "${name}"`);
    database.exec(`DROP TABLE "${name}"; ALTER TABLE "${temporary}" RENAME TO "${name}";`);
    for (const { sql } of definitions) database.exec(sql);
    if (database.prepare(`PRAGMA foreign_key_check("${name}")`).all().length)
      throw new Error('Session source migration foreign key integrity failed');
  }
}

module.exports = { migrateDirectClientSources };
