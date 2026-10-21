import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('navigation precedes compact camera controls and measurements in DOM order',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const positions=['panel-nav','panel-camera-positions','panel-measure'].map(id=>{
    const token=`id="${id}"`;
    assert.equal(html.split(token).length,2,`${id} occurs exactly once`);
    return html.indexOf(token);
  });
  assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]);
  const camera=html.slice(positions[1],positions[2]);
  assert.match(camera,/aria-label="Show camera positions"/);
  assert.doesNotMatch(camera,/class="hint"/);
});
