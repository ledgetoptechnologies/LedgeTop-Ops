import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { post0226StaffPreservationEnvironment } from './ordinary-frontend-authority-post0226-reader.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

test('pinned native D1 CLI emits one parseable local JSON result with the preservation-reader environment', () => {
  const runtime=fileURLToPath(new URL('../apps/operations/node_modules/wrangler/wrangler-dist/cli.js',import.meta.url));
  const profile=JSON.parse(fs.readFileSync(new URL('./production-deploy-profile.json',import.meta.url)));
  assert.equal(createHash('sha256').update(fs.readFileSync(runtime)).digest('hex'),profile.wranglerRuntimeSHA256);
  const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','PATHEXT','HOME']);
  const env=post0226StaffPreservationEnvironment({
    ...Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.has(key.toUpperCase()))),
    CLOUDFLARE_ACCOUNT_ID:NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    CLOUDFLARE_API_TOKEN:'synthetic-local-json-test-token',
    WRANGLER_LOG:'debug',ANOTHER_SECRET:'must-not-reach-child',
  });
  assert.equal(env.ANOTHER_SECRET,undefined);
  assert.equal(env.WRANGLER_WRITE_LOGS,'false');
  assert.equal(env.WRANGLER_SEND_METRICS,'false');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'post0226-native-json-'));
  try {
    const config=path.join(directory,'wrangler.json');
    fs.writeFileSync(config,JSON.stringify({name:'post0226-native-json',compatibility_date:'2026-07-22',
      d1_databases:[{binding:'READ_TEST',database_name:'post0226-native-json',database_id:'11111111-1111-4111-8111-111111111111'}]}));
    // Explicitly local with a synthetic token: this test never reads production.
    const output=execFileSync(process.execPath,[runtime,'d1','execute','READ_TEST','--local','--config',config,'--command','SELECT 1 AS value','--json'],
      {cwd:directory,env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(output);
    assert.equal(result.length,1);
    assert.equal(result[0].success,true);
    assert.deepEqual(result[0].results,[{value:1}]);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('post0226-native-json-'));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('JSON output support retains unsafe-environment refusal',()=>{
  assert.throws(()=>post0226StaffPreservationEnvironment({
    CLOUDFLARE_ACCOUNT_ID:NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    CLOUDFLARE_API_TOKEN:'synthetic-local-json-test-token',HTTPS_PROXY:'https://unreviewed.invalid',
  }),/noninteractive_environment_required/);
});
