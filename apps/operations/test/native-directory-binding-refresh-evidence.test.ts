import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { directoryBindingRefreshEnabled } from '../src/worker/native-directory-binding-refresh';
import { isProjectAlphaDirectoryBindingRevisionRefreshCommand } from '../src/worker/project-alpha-directory-binding-revision-refresh-api-v2';
describe('active binding refresh evidence boundaries',()=>{
  it('uses the exact reviewed financial historical-evidence exception without broadening it',()=>{
    const financial=readFileSync(new URL('../src/worker/project-alpha-financial-mapping.ts',import.meta.url),'utf8');
    const shared=readFileSync(new URL('../src/worker/project-alpha-inventory-historical-generation-evidence.ts',import.meta.url),'utf8');
    const original=financial.slice(financial.indexOf('function historicalCrossSurfaceGenerationConflict('),financial.indexOf('function currentConfiguredRow(')).trim();
    const copy=shared.slice(shared.indexOf('function historicalCrossSurfaceGenerationConflict(')).trim();
    expect(copy.replaceAll('\r\n','\n')).toBe(original.replaceAll('\r\n','\n'));
  });
  it.each(['production','development','preview'])('cannot activate in %s',environment=>{
    expect(directoryBindingRefreshEnabled({ENVIRONMENT:environment,NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'true'})).toBe(false);
  });
  it.each(['staging','local'])('is explicitly default off in %s',environment=>{
    expect(directoryBindingRefreshEnabled({ENVIRONMENT:environment})).toBe(false);
    expect(directoryBindingRefreshEnabled({ENVIRONMENT:environment,NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'true'})).toBe(true);
  });
  it('bounds the decimal generation before SQLite settlement increments it',()=>{
    const command={commandId:'12345678-1234-4123-8123-123456789012',externalId:'external',expectedPriorRevision:'3',expectedLiveRevision:'4',expectedAuthorizationGeneration:'9223372036854775806'};
    expect(isProjectAlphaDirectoryBindingRevisionRefreshCommand(command)).toBe(true);
    expect(isProjectAlphaDirectoryBindingRevisionRefreshCommand({...command,expectedAuthorizationGeneration:'9223372036854775807'})).toBe(false);
    expect(isProjectAlphaDirectoryBindingRevisionRefreshCommand({...command,expectedAuthorizationGeneration:'9223372036854775808'})).toBe(false);
  });
});
