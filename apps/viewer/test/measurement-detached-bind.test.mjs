import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('detached iframe window listeners are removed from the original window before rebinding',()=>{
  const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  function bind(next){'),end=source.indexOf('  const handlers=',start);
  assert.ok(start>=0&&end>start);
  const create=runInNewContext(`(()=>{let bound=null,boundWindow=null,lastSvg=null,pendingPick=null;const handlers=[['pointerdown',()=>{}]],keyDown=()=>{},keyUp=()=>{},blur=()=>{},svg={remove(){},innerHTML:''};function releaseCursor(){}function updateCursor(){}${source.slice(start,end)}return {bind,current:()=>bound};})`);
  const tracker=()=>({added:[],removed:[],addEventListener(type){this.added.push(type)},removeEventListener(type){this.removed.push(type)}});
  const firstWindow=tracker(),secondWindow=tracker(),firstElement={...tracker(),ownerDocument:{defaultView:firstWindow},classList:{remove(){}}},secondElement={...tracker(),ownerDocument:{defaultView:secondWindow},classList:{remove(){}}},host={append(){}};
  const binding=create();binding.bind({element:firstElement,host});assert.deepEqual(firstWindow.added,['keydown','keyup','blur']);
  firstElement.ownerDocument.defaultView=null;
  binding.bind({element:secondElement,host});assert.deepEqual(firstWindow.removed,['keydown','keyup','blur']);assert.deepEqual(secondWindow.added,['keydown','keyup','blur']);
  secondElement.ownerDocument.defaultView=null;binding.bind(null);assert.deepEqual(secondWindow.removed,['keydown','keyup','blur']);assert.equal(binding.current(),null);
  binding.bind({element:secondElement,host});assert.equal(binding.current(),null,'a detached document must not acquire listeners');
});
