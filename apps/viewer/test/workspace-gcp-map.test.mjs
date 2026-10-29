import test from 'node:test';
import assert from 'node:assert/strict';
import { feetToMeters, gcpMapPositions } from '../workspace-gcp-map.mjs';
test('50 feet is the default search radius in metres', () => assert.equal(feetToMeters(50), 15.24));
test('site map plots north and east and omits unlocated photos', () => {
  const map = gcpMapPositions({latitude:45,longitude:-88}, [
    {id:'north', latitude:45.0001,longitude:-88},
    {id:'east', latitude:45,longitude:-87.9999},
    {id:'missing',latitude:null,longitude:null},
  ], 15.24);
  assert.deepEqual(map.cameras.map(item => item.id), ['north','east']);
  assert.ok(map.cameras[0].y < 150); assert.ok(map.cameras[1].x > 150);
  assert.ok(map.radius > 0 && map.radius <= 132);
});
test('invalid point has no map and longitude wraps at the date line', () => {
  assert.equal(gcpMapPositions({latitude:null,longitude:0},[],15.24), null);
  const map=gcpMapPositions({latitude:0,longitude:179.99999},[{id:'cross',latitude:0,longitude:-179.99999}],50);
  assert.ok(map.cameras[0].x>150 && map.cameras[0].x<170);
});
