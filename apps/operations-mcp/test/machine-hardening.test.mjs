import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MachineReadClient, machineConfig } from '../src/machine-client.mjs';
import { readMachineCredential } from '../src/machine-credential.mjs';

const exec = promisify(execFile);
const origin = 'https://ops-staging.ledgetopdroneservices.com';
const credential = { clientId: 'test-only-client.access', clientSecret: 'cfast_test-only-credential' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pa-mcp-private-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'credential.private.json') };
}
async function privateWrite(file, value) {
  await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') return;
  const script = String.raw`$ErrorActionPreference='Stop';
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false);
foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))};
Set-Acl -LiteralPath $env:TEST_PRIVATE_FILE -AclObject $acl;`;
  await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TEST_PRIVATE_FILE: file } });
}

test('real private file is reread on atomic rotation and unsafe replacement stops before network', async t => {
  const { file, dir } = await fixture(t); await privateWrite(file, credential);
  assert.deepEqual(await readMachineCredential(file), credential);
  const calls = [];
  const client = new MachineReadClient({ origin, credentialFile: file }, { fetch: async (_, options) => { calls.push(options.headers); return json({ readOnly: true }); } });
  await client.connection();
  const next = { clientId: 'rotated-test-client.access', clientSecret: 'rotated-test-secret' };
  const replacement = path.join(dir, 'replacement.json'); await privateWrite(replacement, next); await rename(replacement, file);
  await client.connection(); assert.equal(calls.length, 2);
  assert.equal(calls[0]['CF-Access-Client-Secret'], credential.clientSecret); assert.equal(calls[1]['CF-Access-Client-Secret'], next.clientSecret);
  await rm(file); await writeFile(file, JSON.stringify(next), { mode: 0o644 });
  if (process.platform !== 'win32') await chmod(file, 0o644);
  await assert.rejects(client.connection(), error => !error.message.includes(next.clientSecret));
  assert.equal(calls.length, 2);
});

test('malformed/oversized credentials and nonregular path are rejected privately', async t => {
  const { file, dir } = await fixture(t);
  await privateWrite(file, { ...credential, unexpected: 'unaccepted' });
  await assert.rejects(readMachineCredential(file));
  await writeFile(file, 'x'.repeat(20001)); await assert.rejects(readMachineCredential(file));
  await assert.rejects(readMachineCredential(dir));
  // Windows symlink creation needs an OS privilege; POSIX can verify no-follow directly.
  if (process.platform !== 'win32') { const link=path.join(dir,'link');await symlink(file,link);await assert.rejects(readMachineCredential(link)); }
});

test('secret/JWT values and keys cannot escape responses or failure diagnostics', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.synthetic_signature';
  const client = new MachineReadClient({ origin, credentialFile: path.resolve('unused-test.json') }, {
    loadCredential: async () => credential,
    fetch: async () => json({ value: `${jwt} ${credential.clientId} ${credential.clientSecret}`, [credential.clientSecret]: jwt, nested: { 'CF-Access-Jwt-Assertion': jwt, Authorization: jwt } }),
  });
  const text = JSON.stringify(await client.connection());
  for (const value of [jwt, credential.clientId, credential.clientSecret]) assert.ok(!text.includes(value));
  for (const failure of [async()=>{throw Error(`${jwt} ${credential.clientSecret}`);}, async()=>new Response(`${jwt} ${credential.clientSecret}`,{status:403})]) {
    const failed = new MachineReadClient({ origin, credentialFile: path.resolve('unused-test.json') }, { loadCredential: async () => credential, fetch: failure });
    await assert.rejects(failed.connection(), error => !error.message.includes(jwt) && !error.message.includes(credential.clientSecret));
  }
});

test('actual SDK stdio discovers only three machine reads without credentials or network', async t => {
  const { dir } = await fixture(t); let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/machine-cli.mjs', import.meta.url))],
    env: { LTDS_MCP_MACHINE_CREDENTIAL_FILE: path.join(dir,'does-not-exist.json') }, stderr:'pipe' });
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name:'actual-machine-stdio-test',version:'1' });
  t.after(async () => { await client.close(); });
  await client.connect(transport); const result=await client.listTools();
  assert.deepEqual(result.tools.map(tool=>tool.name).sort(),['find_clients','get_client','get_connection']);
  assert.ok(result.tools.every(tool=>tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const denied=await client.callTool({ name:'get_connection',arguments:{} });assert.equal(denied.isError,true);
  assert.equal((await client.callTool({name:'create_client',arguments:{}})).isError,true);
  assert.equal((await client.callTool({name:'get_client',arguments:{sourceId:'project-alpha:staging',recordId:'../escape'}})).isError,true);
  assert.equal(stderr,'');assert.ok(!JSON.stringify(denied).includes(dir));
});


test('TLS verification cannot be disabled through configuration or runtime environment', async () => {
  const credentialFile=path.resolve('unused-test.json');
  assert.throws(()=>machineConfig({LTDS_MCP_MACHINE_CREDENTIAL_FILE:credentialFile,NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
  const prior=process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const client=new MachineReadClient({origin,credentialFile},{loadCredential:()=>assert.fail('credential read'),fetch:()=>assert.fail('network')});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
    await assert.rejects(client.connection());
  } finally {
    if(prior===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=prior;
  }
});


test('protected Windows ACL rejects extra principals and reparse-point parent paths', { skip:process.platform!=='win32' }, async t => {
  const {file,dir}=await fixture(t);await privateWrite(file,credential);
  const junction=path.join(dir,'parent-link');const target=path.join(dir,'target');
  await import('node:fs/promises').then(fs=>fs.mkdir(target));
  const targetFile=path.join(target,'private.json');await privateWrite(targetFile,credential);
  await symlink(target,junction,'junction');await assert.rejects(readMachineCredential(path.join(junction,'private.json')));
  await exec(path.join(process.env.SystemRoot,'System32/icacls.exe'),[file,'/grant','*S-1-1-0:R'],{windowsHide:true});
  await assert.rejects(readMachineCredential(file));
});

test('request timer aborts its own fetch rather than retrying', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let calls=0;
  const client=new MachineReadClient({origin,credentialFile:path.resolve('unused-test.json')},{loadCredential:async()=>credential,
    fetch:async(_,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')), {once:true}));}});
  const request=client.connection();await Promise.resolve();t.mock.timers.tick(20000);
  await assert.rejects(request);assert.equal(calls,1);
});
