const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');
const recovery = fs.readFileSync(path.join(__dirname, '..', 'workspace-recovery.mjs'), 'utf8');

test('expired workspaces use a fixed Operations reauthorization bounce with same-browser replay protection', () => {
  assert.match(recovery, /\/viewer\/reauthorize\?state=/);
  assert.match(recovery, /crypto\.randomUUID\(\)\.replaceAll\('-',''\)/);
  assert.match(source, /Date\.now\(\)-pending\.createdAt<=5\*60\*1000/);
  assert.match(source, /pending\?\.nonce===value/);
  assert.match(source, /sessionStorage\.removeItem\(REAUTH_STATE_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(OPS_ORIGIN_KEY,checked\.controllerOrigin\)/);
  assert.match(source, /parsed\.protocol==='https:'&&parsed\.origin===value/);
  assert.doesNotMatch(source, /return(?:Url|_url)=/);
  // Opening an existing share in a separate popup is not a workspace reload.
  const workspaceNavigation=/(?<![\w.])(?:(?:window|self|globalThis)\.)?location\.(?:assign|replace|reload)\(/;
  assert.doesNotMatch(source,workspaceNavigation);
  assert.match('window.location.reload()',workspaceNavigation);
  assert.match('location.replace(url)',workspaceNavigation);
  assert.doesNotMatch('popup.location.replace(url)',workspaceNavigation);
});

test('known expiry pauses without disposing uploads; unknown authorization loss clears access',()=>{
  const clear=source.split(/\r?\n/).find(line=>line.startsWith('function clearWorkspaceAuthorization('));
  for(const reason of ['expired','revoked','unauthorized']){
    let uploadDisposals=0;
    const calls=[],state={token:'existing',adminSession:{expiresAt:new Date(Date.now()+(reason==='unauthorized'?60000:-1000)).toISOString()}};
    const context=vm.createContext({workspaceAuthorizationClearing:false,state,reviewSessionController:{suspend:options=>calls.push(['suspend',options.preserve])},storageUsagePoll:{stop(){}},workspaceRenewal:{dispose(){}},releaseAllGcpImages(){},sessionStorage:{removeItem(){}},TOKEN_KEY:'token',clearInterval(){},clearTimeout(){},beginWorkspaceReauthorization:()=>{calls.push(['pause']);return true;},renderNav(){},access(){}});
    context.activeNewTask={dispose(){uploadDisposals++;}};
    vm.runInContext(`${clear};clearWorkspaceAuthorization(${JSON.stringify(reason)});clearWorkspaceAuthorization('unauthorized');`,context);
    assert.equal(uploadDisposals,reason==='expired'?0:1);
    assert.equal(calls.filter(call=>call[0]==='suspend').length,reason==='expired'?0:1);
    assert.equal(calls.filter(call=>call[0]==='pause').length,reason==='expired'?1:0);
    assert.equal(state.token,reason==='expired'?'existing':null);
  }
});

test('model routing restoration occurs only after validated workspace session installation',()=>{
  const install=source.split(/\r?\n/).find(line=>line.startsWith('function installWorkspaceSession('));
  assert.ok(install.indexOf('validateWorkspaceSessionEnvelope')<install.indexOf('setAuthenticatedSubject(checked.session.subject)'));
  assert.match(install,/workspaceAuthorizationClearing=false/);
  assert.match(source,/storage:sessionStorage,issueGrant:/);
});
