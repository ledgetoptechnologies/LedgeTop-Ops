import {readFileSync} from 'node:fs';

// Serve/evaluate the actual reachable uploader, with explicit fake endpoint/UI
// dependencies. Tests must not replace its production tracking or unload guard.
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const functions=['function uploadFiles(','async function performLegacyUpload(']
  .map(prefix=>{
    const line=source.split(/\r?\n/).find(value=>value.startsWith(prefix));
    if(!line)throw new Error(`Actual uploader missing: ${prefix}`);
    return line;
  }).join('\n');
const factory=`function createLegacyUploader(dependencies){
  const {navigationWork,state,api,digest,workspaceFetch,sessionStorage,modal,toast,load}=dependencies;
  ${functions}
  return uploadFiles;
}`;
export const legacyUploadModuleSource=`export ${factory}`;
export const createLegacyUploader=new Function(`return (${factory});`)();
