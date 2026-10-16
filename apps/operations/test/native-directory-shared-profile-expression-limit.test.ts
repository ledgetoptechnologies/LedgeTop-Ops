import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

it('compiles shared-member, group and native write guards against full 0207 at production expression depth 100',()=>{
  const script=String.raw`
import json,pathlib,sqlite3,sys
db=sqlite3.connect(':memory:')
names=[]
for m in sorted(pathlib.Path(sys.argv[1]).glob('[0-9][0-9][0-9][0-9]_*.sql')):
 if m.name>'0207_shared_directory_profiles.sql':continue
 db.executescript(m.read_text(encoding='utf-8-sig'));names.append(m.name)
assert len(names)==207
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
tables=['native_directory_shared_profile_creation_fences','native_directory_shared_profiles','native_directory_shared_profile_members','native_directory_shared_profile_commands',
 'native_directory_shared_profile_revisions','operations_directory_write_fences','operations_directory_records',
 'operations_directory_revisions','operations_directory_audit','operations_directory_intents','operations_directory_materializations']
failures=[]
for table in tables:
 columns=[r[1] for r in db.execute('PRAGMA table_xinfo('+table+')') if r[6]==0]
 assert columns,table
 try:db.execute('EXPLAIN INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',['fixture']*len(columns)).fetchall()
 except sqlite3.Error as error:failures.append({'table':table,'error':str(error)})
try:db.execute('EXPLAIN UPDATE native_directory_shared_profiles SET version=version+1,profile_json=? WHERE id=?', ['{}','fixture']).fetchall()
except sqlite3.Error as error:failures.append({'table':'shared_group_update','error':str(error)})
print(json.dumps({'migrations':len(names),'expressionDepth':db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH),'paths':len(tables)+1,'failures':failures}))
sys.exit(bool(failures))
`;
  const r=spawnSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['-c',script,fileURLToPath(new URL('../migrations/',import.meta.url))],{encoding:'utf8',timeout:60_000});
  expect(r.error).toBeUndefined();expect(r.status,`${r.stdout}\n${r.stderr}`).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({migrations:207,expressionDepth:100,paths:12,failures:[]});
});
