import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('navigation precedes compact camera controls, property lines and measurements in DOM order',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const positions=['panel-nav','panel-camera-positions','panel-property-lines','panel-measure'].map(id=>{
    const token=`id="${id}"`;
    assert.equal(html.split(token).length,2,`${id} occurs exactly once`);
    return html.indexOf(token);
  });
  assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]&&positions[2]<positions[3]);
  const camera=html.slice(positions[1],positions[2]);
  assert.match(camera,/aria-label="Show camera positions"/);
  assert.doesNotMatch(camera,/class="hint"/);
  // Property lines sits directly below Camera Positions in the same card style:
  // icon and title only in the header, then one full-width toggle.
  const property=html.slice(positions[2],positions[3]);
  assert.match(property,/^id="panel-property-lines" hidden>\s*<h3><svg viewBox="0 0 24 24">[\s\S]*?<\/svg> Property lines<\/h3>\s*<div class="tool-grid">\s*<button class="layer-btn full" id="layer-property-lines"[^>]*>Show<\/button>\s*<\/div>/);
  assert.equal(property.split('<button').length,2,'one toggle button');
});
