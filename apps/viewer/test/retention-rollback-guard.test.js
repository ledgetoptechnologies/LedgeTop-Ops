'use strict';
// A release without original retention must never run its purge worker on a
// store migrated to schema 46. The updater's own functions are run with a stub
// docker, and the real worker is started view-only. All fixtures are invented.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'scripts/update-truenas.sh'),'utf8').replace(/\r\n/g,'\n');
const posix={skip:process.platform==='win32'?'runs the updater functions with bash on Linux':false};

function part(start,end){
  const from=script.indexOf(start),to=script.indexOf(end,from);
  assert.ok(from>=0&&to>from,`${start} is missing`);
  return script.slice(from,to+end.length);
}
// `aware` lists the images that contain the retention module.
function run(body,{aware=[],processing='true'}={}){
  const harness=`set -euo pipefail
fail() { echo "viewer update: $*" >&2; exit 1; }
compose_args=(--env-file viewer.env); rollback_image=rollback:previous; rollback_compose=rollback.yml
official_latest_image=latest; target_image=target; previous_image_id=sha256:previous
mode=${processing==='true'?'processing':'view-only'}
export PROCESSING_PLATFORM_ENABLED=${processing}
docker() {
  if [[ "$1" == run ]]; then
    local image=""; for value in "$@"; do case "$value" in ${aware.length?aware.join('|'):'__none__'}) image="$value";; esac; done
    [[ -n "$image" ]]; return
  fi
  echo "docker processing=$PROCESSING_PLATFORM_ENABLED $*"
}
${part('retention_module=','\n}\n')}
${body}`;
  const result=spawnSync('bash',['-c',harness],{encoding:'utf8'});
  return {code:result.status,out:result.stdout,err:result.stderr};
}
const rollback=()=>part('rollback() {','\n}\n');

test('automatic rollback to a release without retention starts view-only',posix,()=>{
  const result=run(`${rollback()}\nrollback readiness`);
  assert.equal(result.code,1);
  assert.match(result.out,/docker processing=false compose .*up -d/);
  assert.match(result.err,/view-only/);
});

test('automatic rollback to a release with retention keeps processing on',posix,()=>{
  const result=run(`${rollback()}\nrollback readiness`,{aware:['rollback:previous']});
  assert.match(result.out,/docker processing=true compose .*up -d/);
});

test('a failed pull changes nothing on the store, so the running mode is kept',posix,()=>{
  const result=run(`${rollback()}\nrollback pull`);
  assert.match(result.out,/docker processing=true compose .*up -d/);
});

test('a processing target without retention is refused before anything starts',posix,()=>{
  const gate=part('if [[ "$mode" == processing ]] && ! retention_aware "$target_image"; then','\nfi\n');
  const refused=run(gate);
  assert.equal(refused.code,1);assert.equal(refused.out,'');assert.match(refused.err,/PROCESSING_PLATFORM_ENABLED=false/);
  assert.equal(run(gate,{aware:['target']}).code,0);
  assert.equal(run(gate,{processing:'false'}).code,0,'view-only may run any release');
});

test('the gate runs after the pull and before services are replaced, and checks a file this release ships',()=>{
  const gate=script.indexOf('if [[ "$mode" == processing ]] && ! retention_aware "$target_image"; then');
  assert.ok(gate>script.indexOf(' pull || rollback pull')&&gate<script.indexOf(' up -d --remove-orphans --wait --wait-timeout 180 || rollback startup'));
  const module=script.match(/^retention_module=\/app\/(\S+)$/m)?.[1];
  assert.ok(module&&fs.existsSync(path.join(root,module)),module);
  assert.match(fs.readFileSync(path.join(root,'docker-compose.yml'),'utf8'),/PROCESSING_PLATFORM_ENABLED: \$\{PROCESSING_PLATFORM_ENABLED:-true\}/);
});

test('the runbook states the rollback rule',()=>{
  const text=fs.readFileSync(path.join(root,'docs/RELEASING.md'),'utf8');
  const section=text.slice(text.indexOf('### Rollback after schema 46'),text.indexOf('## Updating the production host'));
  const flat=section.replace(/\s+/g,' ');
  for(const value of ['PROCESSING_PLATFORM_ENABLED=false','Rule: pause first','viewer-worker','A plain container restart keeps the old value','`Config/viewer.env` alone is not enough','backup'])assert.ok(flat.includes(value),value);
  // The line the steps tell a person to look for is the line the worker prints.
  const line='Processing worker is idle because PROCESSING_PLATFORM_ENABLED=false';
  assert.ok(flat.includes(line));assert.ok(fs.readFileSync(path.join(root,'server/worker.js'),'utf8').includes(line));
  const order=['set `PROCESSING_PLATFORM_ENABLED`','Look at the `viewer-worker` log','Only now move `latest` back','Before turning processing back on'].map(value=>flat.indexOf(value));
  assert.ok(order.every((value,index)=>value>0&&(index===0||value>order[index-1])),String(order));
  assert.ok(flat.includes(script.match(/^retention_module=(\S+)$/m)[1]));
});

test('a view-only worker purges nothing and cleans no upload cache',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-view-only-')),file=path.join(dir,'viewer.sqlite');
  const at=(...names)=>path.join(dir,...names);
  let database=openDatabase(file);const processing=new ProcessingRepository(database);
  const project=processing.createProject({displayName:'Invented'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Trashed',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const trashed=at('trash','invented','control.csv');fs.mkdirSync(path.dirname(trashed),{recursive:true});fs.writeFileSync(trashed,'a,b\n');
  database.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(dataset.id);
  database.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_by,created_at) VALUES ('trash-a','dataset',?,'trash','invented',4,'2020-01-01T00:00:00.000Z','staff','2020-01-01T00:00:00.000Z')").run(dataset.id);
  const draft=processing.createDataset({projectId:project.id,displayName:'Draft',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const {upload}=processing.createUpload({datasetId:draft.id,subject:'invented',files:[{id:'file-0',relativePath:'p.csv',byteSize:4096,sha256:'a'.repeat(64)}],
    chunkSize:1024,expiresAt:'2020-01-01T00:00:00.000Z'});
  const cached=at('cache','uploads',upload.id,'file-0','0.part');fs.mkdirSync(path.dirname(cached),{recursive:true});fs.writeFileSync(cached,'partial');
  const snapshot=()=>JSON.stringify(['storage_trash','storage_mutations','upload_sessions','datasets'].map(name=>database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()));
  const before=snapshot();database.close();
  const child=spawn(process.execPath,['server/worker.js'],{cwd:root,env:{...process.env,PROCESSING_PLATFORM_ENABLED:'false',
    EMERGENCY_ADMIN_ENABLED:'false',SERVICE_AUTH_SECRET:'test-service-secret-that-is-at-least-32-characters',
    DATABASE_PATH:file,DATA_DIR:dir,DATASETS_MOUNT:at('datasets'),MODELS_MOUNT:at('models'),CACHE_MOUNT:at('cache'),TRASH_MOUNT:at('trash')}});
  let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(let count=0;count<100&&!output.includes('worker is idle')&&child.exitCode===null;count+=1)await new Promise(resolve=>setTimeout(resolve,100));
  assert.match(output,/worker is idle/);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(child.exitCode,null,output);
  const gone=once(child,'exit');child.kill();await gone;
  database=openDatabase(file);const after=snapshot();database.close();
  assert.equal(after,before);
  assert.ok(fs.existsSync(trashed));assert.ok(fs.existsSync(cached));
});
