// SQLite LIKE treats '_' as a wildcard. Exclude only the reserved sqlite_
// namespace, retaining legal application names such as sqliteX_visible.
export const WINDOWS_SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(lower(name),1,7) <> 'sqlite_' ORDER BY type,name,tbl_name";
