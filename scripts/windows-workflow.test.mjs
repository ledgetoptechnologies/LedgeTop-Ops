import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/windows-download.yml',import.meta.url),'utf8');
// Fixed-workflow regression checks, not a replacement for the GitHub YAML schema.
// Official context availability: jobs.<job_id>.env excludes runner; step run permits it.
function jobEnvContexts(source){
 const block=source.match(/^    env:\r?\n([\s\S]*?)(?=^    steps:)/m)?.[1];
 assert.ok(block,'expected one Windows job env block');
 const allowed=new Set(['github','needs','strategy','matrix','vars','secrets','inputs']);
 for(const expression of block.matchAll(/\$\{\{([\s\S]*?)\}\}/g))
  for(const root of expression[1].matchAll(/\b([a-z_]\w*)\s*\./gi))
   assert.ok(allowed.has(root[1]),`context unavailable in job env: ${root[1]}`);
}
test('job env uses only officially permitted contexts',()=>jobEnvContexts(workflow));
test('draft PRs run the same bounded source checks without branch-specific or dispatch triggers',()=>{
 assert.doesNotMatch(workflow,/pull_request\.draft|workflow_dispatch|codex\/windows-sync/);
 assert.match(workflow,/push:\s+branches: \[main\]/);
 assert.match(workflow,/pull_request:\s+branches: \[main\]/);
 assert.match(workflow,/contents: read/);
});
test('the previous runner.temp job-env defect is rejected',()=>{
 const old=workflow.replace('    env:', '    env:\n      NUGET_PACKAGES: ${{ runner.temp }}/windows-files-nuget');
 assert.throws(()=>jobEnvContexts(old),/context unavailable in job env: runner/);
});
test('runner paths are initialized through GITHUB_ENV before setup or restore',()=>{
 const init=workflow.indexOf('- name: Set isolated runner paths');
 assert.ok(init>0&&init<workflow.indexOf('- uses: actions/setup-dotnet@'));
 const block=workflow.slice(init,workflow.indexOf('- uses: actions/setup-dotnet@'));
 for(const key of ['NUGET_PACKAGES','WINDOWS_SDK_CONFIG','DOTNET_CLI_HOME','LEDGETOP_TEST_ARTIFACT_ROOT'])assert.ok(block.includes(`${key}=$env:RUNNER_TEMP/`));
 assert.ok(block.includes('$env:GITHUB_ENV')&&block.includes('-Append'));
});
test('hosted packaging checks use current reviewed source and fresh synthetic fixtures',()=>{
 for(const script of ['windows-bootstrap-packaging-test-tools.ps1','windows-bootstrap-packaging-test-tools.test.ps1','windows-unsigned-installer.test.ps1','windows-release-test-fixture.ps1','windows-app-release-offer.test.ps1'])assert.ok(workflow.includes(script));
 assert.ok(workflow.includes('git rev-parse HEAD')&&workflow.includes('-RequirePositiveValidation'));
 assert.doesNotMatch(workflow,/fstor|--owned-native-preview|windows-installer-isolated-acceptance\.ps1|Start-Process|--installer-remove-connections/);
});
