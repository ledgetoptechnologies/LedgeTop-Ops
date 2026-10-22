import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWorkspaceDialogs, validateDialogValues } from '../workspace-dialogs.mjs';

// DOM lifecycle double: tests execute the shipped dialog module. Native focus
// trapping/top-layer rendering still require browser QA, not this fake DOM.
function documentFixture() {
  const doc = { activeElement: null, defaultView: new EventTarget() };
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName=tag;this.children=[];this.attributes={};this.value='';this.open=false; }
    append(...nodes) { for(const node of nodes){node.parent=this;this.children.push(node);} }
    setAttribute(name,value) {this.attributes[name]=value;}
    removeAttribute(name) {delete this.attributes[name];}
    get isConnected(){return this===doc.body||Boolean(this.parent?.isConnected);}
    closest(){let node=this;while(node){if(node.tagName==='dialog'&&node.open)return node;node=node.parent;}return null;}
    focus(){doc.activeElement=this;}
    showModal(){this.open=true;}
    close(){this.open=false;this.dispatchEvent(new Event('close'));}
    remove(){if(this.parent){this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}}
  }
  doc.createElement=tag=>new Element(tag);
  doc.body=new Element('body');
  const trigger=new Element('button');doc.body.append(trigger);trigger.focus();
  const nodes=(root,tag)=>root.children.flatMap(node=>[...(node.tagName===tag?[node]:[]),...nodes(node,tag)]);
  return {doc,trigger,nodes,dialog:()=>nodes(doc.body,'dialog').at(-1)};
}
function submit(f,dialog=f.dialog()){f.nodes(dialog,'form')[0].dispatchEvent(new Event('submit',{cancelable:true}));}
function click(node){node.dispatchEvent(new Event('click'));}

test('validation protects exact identifiers, required text, max lengths and declared choices',()=>{
  assert.equal(validateDialogValues([{name:'id',label:'Identifier',exact:'ABC'}],{id:' ABC'}).message,'Identifier did not match; nothing was deleted.');
  assert.equal(validateDialogValues([{name:'id',label:'Identifier',exact:'ABC'}],{id:'ABC'}),null);
  assert.ok(validateDialogValues([{name:'name',label:'Name',required:true}],{name:'  '}));
  assert.ok(validateDialogValues([{name:'name',label:'Name',maxLength:2}],{name:'abc'}));
  assert.ok(validateDialogValues([{name:'unit',label:'Unit',options:[{value:'m'}]}],{unit:'ft'}));
});

test('confirmation focuses Cancel, resolves once, removes its layer and restores trigger',async()=>{
  const f=documentFixture(),dialogs=createWorkspaceDialogs(f.doc);
  const pending=dialogs.confirm('Delete this?',{destructive:true});
  const dialog=f.dialog();assert.equal(dialog.open,true);
  assert.equal(f.doc.activeElement.textContent,'Cancel');
  assert.equal(dialog.attributes['aria-labelledby'].endsWith('-title'),true);
  assert.equal(await dialogs.confirm('Duplicate'),false);
  submit(f);assert.equal(await pending,true);
  assert.equal(f.dialog(),undefined);assert.equal(f.doc.activeElement,f.trigger);
});

test('Escape cancels only the decision and leaves existing workspace modal intact',async()=>{
  const f=documentFixture(),parent=f.doc.createElement('dialog');f.doc.body.append(parent);parent.showModal();parent.append(f.trigger);f.trigger.focus();
  const pending=createWorkspaceDialogs(f.doc).form({title:'Reason',fields:[{name:'reason',label:'Reason'}]});
  const event=new Event('cancel',{cancelable:true});f.dialog().dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);assert.equal(await pending,null);
  assert.equal(parent.open,true);assert.equal(f.doc.activeElement,f.trigger);
});

test('parent close and pagehide cancel pending decisions without a mutation',async()=>{
  for(const closeParent of [true,false]){
    const f=documentFixture(),parent=f.doc.createElement('dialog');f.doc.body.append(parent);parent.showModal();parent.append(f.trigger);f.trigger.focus();
    const pending=createWorkspaceDialogs(f.doc).confirm('Continue?');
    if(closeParent)parent.close();else f.doc.defaultView.dispatchEvent(new Event('pagehide'));
    assert.equal(await pending,false);assert.equal(f.nodes(f.doc.body,'dialog').length,1);
  }
});

test('form supports atomic task editing, inline errors, lengths and literal untrusted text',async()=>{
  const f=documentFixture(),pending=createWorkspaceDialogs(f.doc).form({title:'<img src=x>',fields:[{name:'name',label:'Task name',required:true,maxLength:240},{name:'description',label:'Description',multiline:true,maxLength:4000,value:'<script>text</script>'}]});
  const dialog=f.dialog(),input=f.nodes(dialog,'input')[0],description=f.nodes(dialog,'textarea')[0];
  assert.equal(f.doc.activeElement,input);assert.equal(input.maxLength,240);assert.equal(description.maxLength,4000);
  assert.equal(f.nodes(dialog,'h2')[0].textContent,'<img src=x>');assert.equal(description.value,'<script>text</script>');
  submit(f);assert.equal(dialog.open,true);assert.equal(input.attributes['aria-invalid'],'true');
  input.value='Church';input.dispatchEvent(new Event('input'));submit(f);
  assert.deepEqual(await pending,{name:'Church',description:'<script>text</script>'});
});

test('typed purge mismatch stays open and exact match is not normalized',async()=>{
  const f=documentFixture(),pending=createWorkspaceDialogs(f.doc).form({title:'Purge',fields:[{name:'typedId',label:'Exact identifier',exact:'AbC',required:true}]});
  const input=f.nodes(f.dialog(),'input')[0];input.value='abc';submit(f);assert.equal(f.dialog().open,true);
  input.value='AbC';submit(f);assert.deepEqual(await pending,{typedId:'AbC'});
});

test('unavailable native dialog fails closed instead of using browser prompts',async()=>{
  const f=documentFixture(),create=f.doc.createElement;
  f.doc.createElement=tag=>{const node=create(tag);if(tag==='dialog')node.showModal=()=>{throw new Error('unavailable')};return node;};
  assert.equal(await createWorkspaceDialogs(f.doc).confirm('Continue?'),false);assert.equal(f.dialog(),undefined);
});

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function handler(name,globals){const line=source.split('\n').find(line=>line.startsWith(`async function ${name}(`));assert.ok(line);return vm.runInNewContext(`${line};${name}`,globals);}
test('all active workspace native prompts are removed, not hidden behind wrappers',()=>{
  assert.doesNotMatch(source,/(?<![\w.])(?:prompt|confirm|alert)\s*\(/);
  assert.match(source,/createWorkspaceDialogs/);
  assert.match(source,/onclick=async\(\)=>\{const input=await dialogs.form\(\{title:'Revoke client access'/);
});
test('task edit cancellation aborts the entire rename, accepted form performs one PATCH',async()=>{
  const calls=[],state={tasks:[{id:'task',displayName:'Old',description:'Keep'}]};
  const mutate=(...args)=>calls.push(args);
  await handler('editTask',{state,mutate,dialogs:{form:async()=>null}})('task');assert.equal(calls.length,0);
  await handler('editTask',{state,mutate,dialogs:{form:async()=>({displayName:'New',description:'New description'})}})('task');
  assert.equal(calls.length,1);assert.equal(calls[0][1].body.description,'New description');
});
test('purge cancellation never calls API and accepted request carries exact typed identifier',async()=>{
  const calls=[],mutate=(...args)=>calls.push(args);
  await handler('purgeTrash',{mutate,dialogs:{form:async()=>null}})('trash','item');assert.equal(calls.length,0);
  await handler('purgeTrash',{mutate,dialogs:{form:async()=>({typedId:'item'})}})('trash','item');
  assert.equal(calls[0][0],'/api/v1/storage/trash/trash');assert.equal(calls[0][1].body.typedId,'item');
});
test('ordinary and trash mutations await decisions and cancellation keeps state untouched',async()=>{
  const calls=[],state={busy:false};const globals={state,mutate:(...args)=>calls.push(args),dialogs:{confirm:async()=>false}};
  await handler('confirmedMutation',globals)('Proceed?','/path',{},'Done');
  await handler('trashMutation',globals)('Delete?','/path','Done');
  assert.equal(calls.length,0);assert.equal(state.busy,false);
});
