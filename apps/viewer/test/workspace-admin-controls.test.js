'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','isolated-viewer-launch.mjs'),'utf8');

test('staff output actions exchange the admin bearer for streamed narrow downloads and mint published sessions',()=>{
  assert.match(source,/async function authenticatedDownload/);
  assert.match(source,/Authorization:`Bearer \$\{state\.token\}`/);
  const download=source.split(/\r?\n/).find(line=>line.startsWith('async function authenticatedDownload('));
  assert.match(download,/download-grants/);
  assert.match(download,/product-downloads/);
  assert.doesNotMatch(download,/\.blob\(|createObjectURL/);
  assert.match(download,/link\.referrerPolicy='no-referrer'/);
  assert.match(source,/async function viewPublishedOutput/);
  assert.match(source,/\/processing\/outputs\/\$\{encodeURIComponent\(id\)\}\/view-sessions/);
  assert.match(source,/import \{ beginIsolatedViewerLaunch \} from '\.\/isolated-viewer-launch\.mjs'/);
  assert.match(launcher,/windowRef\.open\(launcherUrl, windowName, 'noopener'\)/);
  const publishedLaunch=source.split(/\r?\n/).find(line=>line.startsWith('async function viewPublishedOutput('));
  assert.match(publishedLaunch,/await readyViewerLauncher\(\)/);
  assert.match(source,/async function readyViewerLauncher\(\)\{const launch=beginIsolatedViewerLaunch\(\)/);
  assert.doesNotMatch(publishedLaunch,/window\.open\('about:blank'/);
  // Public-link Open reserves a window during the user gesture, then severs its
  // opener before the authenticated URL lookup. Staff launches remain isolated.
  const publicLinkOpen=source.slice(source.indexOf('async function retrieveShareLink('),source.indexOf('async function confirmSharedVersionUpdate('));
  assert.match(publicLinkOpen,/if\(popup\)popup\.opener=null/);
  assert.match(publicLinkOpen,/url\.origin!==location\.origin/);
  assert.match(source,/reviewSessionController\.track\(launch\.channelId,\{attemptId:result\.attemptId,modelId:result\.modelId,modelVersionId:result\.modelVersionId,sessionTtlSeconds:result\.sessionTtlSeconds\}\)/);
  assert.match(source,/sessionMode:'published',outputId:id,modelId:result\.modelId,modelVersionId:result\.modelVersionId/);
  assert.doesNotMatch(source,/launch\.navigate\(result\.embedUrl,\{renewable:false\}\)/);
  assert.match(source,/output\.activePublished.*button\('share-output'/);
  assert.match(source,/state\.outputs\.filter\(output=>output\.activePublished\)/);
  assert.doesNotMatch(source,/<a[^>]+href="\$\{esc\(output\.(?:download|report)Url\)\}/);
});

test('task expansion loads bounded immutable attempt history',()=>{
  assert.match(source,/\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/attempts\?limit=20/);
  assert.match(source,/function attemptHistory/);
  assert.match(source,/Every recorded run/);
  assert.match(source,/load-more-attempts/);
  assert.match(source,/\/attempts\/\$\{encodeURIComponent\(attemptId\)\}\/diagnostics\?eventLimit=100&logLimit=200/);
  assert.match(source,/Run #\$\{available\(item\.attemptNumber/);
  assert.match(source,/\['failed','cancelled'\]\.includes\(item\.status\)/);
  assert.match(source,/state\.tasks=state\.tasks\.map\(item=>item\.id===taskId\?refreshedTask:item\)/);
  assert.match(source,/id="\$\{esc\(panelId\)\}"/);
  assert.match(source,/aria-controls="\$\{esc\(panelId\)\}"/);
  assert.match(source,/retry-attempt-diagnostics/);
});

test('node administration supports metadata credential and capability-bound preset maintenance',()=>{
  for(const action of ['edit-provider','replace-provider-token','clear-provider-token','new-preset','view-preset','duplicate-preset','import-preset','edit-preset','delete-preset'])assert.ok(source.includes(action),action);
  assert.match(source,/\/processing\/providers\/\$\{encodeURIComponent\(provider\.id\)\}\/credential/);
  assert.match(source,/Changing the endpoint disables the node until its capabilities are probed again/);
  assert.match(source,/mountTaskOptions\(\{container:form\.querySelector\('#preset-options-editor'\)/);
  assert.match(source,/refreshProviderCapabilities\(providerId\)/);
  assert.match(source,/capabilities\/refresh/);
  assert.match(source,/Unsupported values are rejected by server validation/);
  assert.match(source,/options=\{\.\.\.baseOptions,\.\.\.editor\.getOptions\(\)\}/);
  assert.doesNotMatch(source,/Provider options \(JSON\)/);
});

test('trash lifecycle keeps permanent deletion behind exact typed confirmation',()=>{
  assert.match(source,/data-action="purge-trash"|(?:button|dangerButton)\('purge-trash'/);
  assert.match(source,/name:'typedId'[^}]*exact:entityId/);
  assert.match(source,/body:\{typedId:input\.typedId\}/);
  assert.match(source,/Permanent deletion cannot be undone/);
  assert.match(source,/\['trash','♲','Recycle Bin'\]/);
  assert.match(source,/View Recycle Bin/);
  assert.match(source,/function trash\(\)/);
  assert.match(source,/trashLoadError/);
});

test('project-first lifecycle exposes rename and recoverable delete without archive-first UI',()=>{
  for(const action of ['edit-project','edit-task','trash-project','trash-task','trash-dataset','trash-output','restore-trash','purge-trash','retry-storage-mutation'])assert.ok(source.includes(action),action);
  for(const removed of ['archive-project','archive-task','archive-dataset','archive-output'])assert.equal(source.includes(removed),false,removed);
  for(const permission of ['viewer.projects.write','viewer.storage.purge','viewer.processing.write','viewer.processing.publish'])assert.ok(source.includes(`can('${permission}')`),permission);
  assert.match(source,/function confirmedMutation/);
  assert.match(source,/function editProject/);
  assert.match(source,/function editTask/);
  assert.match(source,/remain recoverable in the Recycle Bin for 14 days/);
  assert.match(source,/restored until \$\{purgeDate\(30\)\}/);
  assert.match(source,/after that date it will be permanently purged/);
  assert.match(source,/project is archived and read-only/);
  assert.match(source,/task\.status==='archived'\?'task':'project'\} is archived and read-only/);
  assert.match(source,/pagedStorage/);
  assert.match(source,/storage\/mutations\?status=failed/);
  assert.match(source,/\/storage\/mutations\/\$\{encodeURIComponent\(id\)\}\/retry/);
});

test('server-folder copy is explicit about immediate durable import without a preview',()=>{
  assert.match(source,/\/api\/v1\/processing\/server-task-imports/);
  assert.match(source,/immediately queues a durable import/);
  assert.match(source,/there is no preview step/);
  assert.doesNotMatch(source,/supported artifacts after confirmation/);
});
