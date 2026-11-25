import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as directClientShare from '../workspace-direct-client-share.mjs';

// What the Share dialog says about an end date it cannot read, and after a refused client share. Shipped functions, synthetic data.
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function declaration(name){
  const match=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(source);
  assert.ok(match,`Missing shipped function ${name}`);
  const rest=source.slice(match.index),next=/\n(?:async )?function \w+\(|\nconst \w+\s*=/.exec(rest);
  return next?rest.slice(0,next.index):rest;
}
// The shipped formatter, so an unreadable date reads as it does in a browser.
const dateTime=vm.runInNewContext(`${/^const dateTime=.*$/m.exec(source)[0]}dateTime`);
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const PAST='2020-01-01T00:00:00Z',LATER='2999-01-01T00:00:00Z',UNREADABLE='not a date';

test('a project link with an unreadable end is expired, and says its end is unknown',()=>{
  const target={innerHTML:''},tab={textContent:''},state={projectShares:{project:[{id:'a',expiresAt:UNREADABLE},{id:'b',expiresAt:PAST},{id:'c',expiresAt:LATER},{id:'d'},{id:'e',expiresAt:UNREADABLE,revokedAt:PAST}]}};
  const context=vm.createContext({state,esc,dateTime,can:()=>true,card:(title,body)=>body,badge:value=>`<b>${esc(value)}</b>`,button:(action,id,label)=>`<button data-id="${id}">${label}</button>`,bindProjectShareCard(){},
    modalContent:{querySelector:selector=>selector==='[data-legacy-project-shares]'?target:tab}});
  vm.runInContext(['publicLinkState','publicTabLabel','injectProjectShareCard'].map(declaration).join('\n'),context);context.injectProjectShareCard('project');
  const rows=target.innerHTML.split('manage-row').slice(1).map(row=>({text:/<small>(.*?)<\/small>/.exec(row)[1].split(' · ').at(-1),badge:/<b>(.*?)<\/b>/.exec(row)[1],revocable:row.includes('Revoke')}));
  assert.doesNotMatch(target.innerHTML,/Invalid Date/);
  assert.deepEqual(rows[0],{text:'Expired, end date unknown',badge:'expired',revocable:true});
  assert.equal(rows[1].text,`Expired ${dateTime(PAST)}`);assert.equal(rows[2].text,`Expires ${dateTime(LATER)}`);assert.equal(rows[3].text,'No expiry');
  assert.deepEqual(rows.map(row=>row.badge),['expired','expired','active','active','revoked']);assert.equal(rows[4].text,'End date unknown');
  assert.equal(tab.textContent,'Public link (2)');
});

test('a model link’s settings say the same',()=>{
  const context=vm.createContext({dateTime,shareViewLabels:()=>({})});vm.runInContext(declaration('shareSettingsSummary'),context);
  const end=expiresAt=>context.shareSettingsSummary({permissions:{},allowedViews:null,expiresAt}).split(' · ').at(-1);
  assert.equal(end(UNREADABLE),'End date unknown');assert.equal(end(LATER),`Expires ${dateTime(LATER)}`);assert.equal(end(null),'No expiry');
});

test('a client’s share with an unreadable end says it is expired, and that revoking it frees its place',()=>{
  const row=expiresAt=>directClientShare.directGrantRows({grants:[{grantId:'g',viewerProjectId:'project',scopeType:'project',taskId:null,clientDisplayName:'Example',expiresAt,revokedAt:null}]},{projectId:'project',tasks:[],dateTime});
  assert.doesNotMatch(row(UNREADABLE),/Invalid Date/);assert.match(row(UNREADABLE),/Expired, end date unknown; revoke it to share this again/);assert.match(row(UNREADABLE),/status expired/);
  assert.ok(row(PAST).includes(`Expired ${dateTime(PAST)}; revoke it`));assert.ok(row(LATER).includes(`Expires ${dateTime(LATER)}`));
});

// The shipped client form around a server that answers as told.
function shareForm(answers,{tasks=['task']}={}){
  const toasts=[],posts=[],review={hidden:true},reviewButton={hidden:false},summary={textContent:''},handlers={},elements={};
  const part=selector=>({'[data-direct-summary]':summary,'[data-direct-review]':review,'[data-direct-review-button]':reviewButton,'[data-direct-back]':elements.back||=({}),'[data-direct-send]':{focus(){}},'[data-direct-review-text]':{textContent:''}})[selector]||null;
  const choices={summary:'Pat Example will see Task one.',permissions:{},expiresAt:null};
  const form={isConnected:true,elements:{},querySelector:part,querySelectorAll:()=>[]};
  const context=vm.createContext({crypto:{randomUUID:()=>`key-${posts.length}`},state:{shareContext:{}},modal:{open:true},toast:(text,bad)=>toasts.push([text,Boolean(bad)]),dateTime,
    directShareContext:()=>({projectId:'project'}),readDirectShareForm:()=>({scope:'tasks',what:choices.what,summary:choices.summary,bodies:({confirmed}={})=>{choices.confirmed=confirmed;if(choices.invalid)throw new Error(choices.invalid);return tasks.map(taskId=>({taskId,permissions:{}}))}}),
    SHARE_TARGET_MISSING:'missing',directShareReviewMarkup:()=>'review',directClientKey:()=>'k',refreshProjectOutputs:async()=>true,directShareErrorText:error=>`Refused: ${error.message}`,DIRECT_CLIENT_GRANTS_PATH:'/grants',
    api:async(path,options)=>{posts.push(options.body);const answer=answers.shift();if(answer instanceof Error)throw answer;return answer},loadDirectClientAccess:async()=>null,rerenderClientSharePanel(){},directClientAccess:value=>value,bindClientPicker(){}});
  vm.runInContext(declaration('bindDirectShare'),context);context.bindDirectShare(form,'project','output');
  return {form,summary,review,toasts,posts,choices,submit:()=>form.onsubmit({preventDefault(){}}),change:()=>form.onchange(),back:()=>elements.back.onclick()};
}
test('after a refused client share the reason stays beside the form until something is changed',async()=>{
  const f=shareForm([new Error('not this client'),{}]);
  await f.submit();assert.equal(f.form.reviewing,true);assert.equal(f.choices.confirmed,false);
  await f.submit();
  assert.deepEqual(f.toasts,[['Refused: not this client',true]]);assert.equal(f.form.reviewing,false,'the form can be changed again');assert.equal(f.review.hidden,true);
  assert.equal(f.summary.textContent,'Refused: not this client');
  f.choices.summary='Pat Example will see Task two.';f.change();assert.equal(f.summary.textContent,'Pat Example will see Task two.');
  // Asked again, the review starts from the choices and not from the old reason.
  await f.submit();assert.equal(f.form.reviewing,true);assert.equal(f.summary.textContent,'');
  await f.submit();assert.equal(f.choices.confirmed,true);assert.deepEqual(f.toasts.at(-1),['Shared with the client',false]);
});
test('reviewing again without a change drops the old reason too, and Back shows the choices',async()=>{
  const f=shareForm([new Error('no')]);await f.submit();await f.submit();assert.equal(f.summary.textContent,'Refused: no');
  await f.submit();assert.equal(f.summary.textContent,'');
  f.back();assert.equal(f.summary.textContent,f.choices.summary);assert.equal(f.form.reviewing,false);
});
test('a share refused halfway says how far it went, and keeps saying it',async()=>{
  const f=shareForm([{},new Error('stopped')],{tasks:['one','two','three']});await f.submit();await f.submit();
  assert.equal(f.posts.length,2);assert.equal(f.summary.textContent,'Shared 1 of 3. Share again to finish; already shared tasks are not duplicated. Refused: stopped');
});
test('choices that became invalid during the review say so beside the form',async()=>{
  const f=shareForm([]);await f.submit();f.choices.invalid='Tick the confirmation.';await f.submit();
  assert.equal(f.summary.textContent,'Tick the confirmation.');assert.equal(f.form.reviewing,false);assert.equal(f.posts.length,0);
});
test('what changed after the review is not sent: the form opens again',async()=>{
  const f=shareForm([{}]);f.choices.what='one';await f.submit();assert.equal(f.form.reviewing,true);
  f.choices.what='two';await f.submit();
  assert.equal(f.posts.length,0);assert.equal(f.form.reviewing,false);assert.match(f.summary.textContent,/changed since the review/);
  await f.submit();f.change();assert.equal(f.form.reviewing,false,'a change of any control leaves the review');
  await f.submit();await f.submit();assert.equal(f.posts.length,1);
});
test('nothing is written into a dialog that was replaced meanwhile',async()=>{
  const f=shareForm([new Error('late')]);await f.submit();const sending=f.submit();f.form.isConnected=false;f.summary.textContent='another dialog';await sending;
  assert.equal(f.summary.textContent,'another dialog');
});
