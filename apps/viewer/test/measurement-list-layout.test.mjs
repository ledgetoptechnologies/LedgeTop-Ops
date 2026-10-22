import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMeasurementListLayout} from '../measurement-list-layout.mjs';

function fixture(heights = []) {
  let callback, disconnects = 0;
  const observed = new Set();
  class Observer {
    constructor(fn) { callback = fn; }
    observe(node) { observed.add(node); }
    disconnect() { disconnects++; observed.clear(); }
  }
  const rows = heights.map(height => ({ height, getBoundingClientRect() { return { height:this.height }; } }));
  const list = {dataset:{},style:{},attributes:{},scrollTop:70,
    setAttribute(key,value) { this.attributes[key] = value; },
    querySelectorAll() { return rows; }};
  const layout = createMeasurementListLayout(list,{ResizeObserverClass:Observer,computedStyle:()=>({rowGap:'8px',paddingTop:'2px',paddingBottom:'2px'})});
  return {list,layout,rows,observed,resize:()=>callback(),disconnects:()=>disconnects};
}

for (const count of [0,1,2]) test(`${count} saved records use natural height with no list scrollbar or redundant keyboard stop`, () => {
  const f=fixture([140,190]);f.layout.update(3);f.layout.update(count);
  assert.equal(f.list.dataset.scrollable,'false');assert.equal(f.list.dataset.empty,String(count===0));
  assert.equal(f.list.style.maxHeight,'');assert.equal(f.list.scrollTop,0);assert.equal(f.list.attributes.tabindex,'-1');
  assert.equal(f.observed.size,0);assert.match(f.list.attributes['aria-label'],new RegExp(`${count} record`));f.layout.dispose();
});

test('three or more records show exactly two measured cards, including wrapped results, and expose keyboard scrolling', () => {
  const f=fixture([140,190,250,160]);f.layout.update(3);
  assert.equal(f.list.dataset.scrollable,'true');assert.equal(f.list.style.maxHeight,'342px');
  assert.equal(f.list.attributes.tabindex,'0');assert.match(f.list.attributes['aria-label'],/3 records\. Scroll to see more\./);
  assert.equal(f.observed.size,3);assert.ok(f.observed.has(f.list));assert.ok(!f.observed.has(f.rows[2]));
  f.layout.update(4);assert.equal(f.list.style.maxHeight,'342px');f.layout.dispose();
});

test('zoom and card content changes resize the two-card viewport without fixed desktop/mobile heights', () => {
  const f=fixture([140,190,250]);f.layout.update(3);
  f.rows[0].height=210.3;f.rows[1].height=230.1;f.resize();assert.equal(f.list.style.maxHeight,'453px');
  // A hidden sidebar must not become a zero-height list; observe its return.
  f.rows[0].height=0;f.resize();assert.equal(f.list.style.maxHeight,'453px');
  f.rows[0].height=180;f.resize();assert.equal(f.list.style.maxHeight,'423px');f.layout.dispose();
});

test('disposed list releases observers and ignores queued resize callbacks', () => {
  const f=fixture([140,190,250]);f.layout.update(3);f.layout.dispose();
  assert.equal(f.observed.size,0);f.rows[0].height=1000;f.resize();assert.equal(f.list.style.maxHeight,'342px');
  f.layout.update(0);assert.equal(f.list.dataset.scrollable,'true');assert.ok(f.disconnects()>=2);
});

test('temporary collection label survives accessible count and scroll updates',()=>{
  const f=fixture([140,190,250]);f.layout.update(3,'Temporary measurements');
  assert.equal(f.list.attributes['aria-label'],'Temporary measurements, 3 records. Scroll to see more.');
  f.layout.update(0,'Temporary measurements');assert.equal(f.list.attributes['aria-label'],'Temporary measurements, 0 records');f.layout.dispose();
});

test('native scroll behavior, orange thumb, keyboard focus and high-contrast fallback are preserved', () => {
  const css=readFileSync(new URL('../measurement-workspace.css',import.meta.url),'utf8');
  assert.match(css,/\[data-scrollable=true\]\{[^}]*overflow-y:auto/);
  assert.match(css,/scrollbar-width:thin;scrollbar-color:#ee5007 transparent/);
  assert.match(css,/\[data-m-list\]:focus-visible\{outline:2px solid/);
  assert.match(css,/@media\(forced-colors:active\)/);
  assert.doesNotMatch(css,/\[data-m-list\][^{]*\{[^}]*(?:height:420px|height:380px|resize:vertical)/);
  const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
  assert.match(source,/listLayout\.dispose\(\)/);assert.match(source,/focus\(\{preventScroll:true\}\)/);
  assert.match(source,/<details class="measurement-help"><summary>Controls &amp; accuracy/);
  assert.match(source,/<label class="measurement-units">Export format <select/);
});
