'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { odmGcpList } = require('../server/gcpOdm');

test('canonical WGS84 correspondences serialize in ODM documented coordinate and pixel order', () => {
  assert.equal(odmGcpList([{
    longitude: -88.1002, latitude: 44.5001, elevationM: 243.84,
    pixelX: 120.5, pixelY: 240.25, relativePath: 'flight/IMG_0001.JPG',
  }]), 'EPSG:4326\n-88.1002 44.5001 243.84 120.5 240.25 IMG_0001.JPG\n');
  assert.equal(odmGcpList([]), null);
});

test('ODM GCP list emits a valid NAVD88 compound CRS for Emlid NAD83(2011) coordinates', () => {
  assert.equal(odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'NAVD88(GEOID18) height',
  }]), 'EPSG:6349\n-88.1 44.5 250 1 2 photo.jpg\n');
  assert.equal(odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'Ellipsoidal height',
  }]), 'EPSG:6319\n-88.1 44.5 250 1 2 photo.jpg\n');
  assert.throws(() => odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'NAVD88(GEOID18) height',
  }], { requireSupportedTransform: true }), (error) => error.code === 'gcp_vertical_transform_unavailable');
  assert.equal(odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, ellipsoidalHeightM: 219.6,
    pixelX: 1, pixelY: 2, relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'NAVD88(GEOID18) height',
  }], { heightSource: 'ellipsoidal', requireSupportedTransform: true }), 'EPSG:6319\n-88.1 44.5 219.6 1 2 photo.jpg\n');
  assert.throws(() => odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, ellipsoidalHeightM: null,
    pixelX: 1, pixelY: 2, relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'NAVD88(GEOID18) height',
  }], { heightSource: 'ellipsoidal', requireSupportedTransform: true }), (error) => error.code === 'gcp_ellipsoidal_height_missing');
  assert.throws(() => odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:4326', verticalDatum: 'NAVD88(GEOID18) height',
  }]), (error) => error.code === 'invalid_gcp_correspondence', 'fail closed rather than write an invalid or misleading compound CRS');
  assert.throws(() => odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:6318', verticalDatum: 'NAVD88',
  }], { requireSupportedTransform: true }), (error) => error.code === 'gcp_vertical_transform_unavailable');
  assert.throws(() => odmGcpList([
    { longitude: -88, latitude: 44, elevationM: 250, pixelX: 1, pixelY: 2, relativePath: 'a.jpg', horizontalCrs: 'EPSG:6318' },
    { longitude: -88, latitude: 44, elevationM: 250, pixelX: 1, pixelY: 2, relativePath: 'b.jpg', horizontalCrs: 'EPSG:4326' },
  ]), /one supported horizontal CRS/);
});

test('ODM GCP export names EGM vertical datums in the compound CRS header', () => {
  assert.equal(odmGcpList([{
    longitude: -88.1, latitude: 44.5, elevationM: 250, pixelX: 1, pixelY: 2,
    relativePath: 'photo.jpg', horizontalCrs: 'EPSG:4326', verticalDatum: 'EGM96 height',
  }]), 'EPSG:4326+5773\n-88.1 44.5 250 1 2 photo.jpg\n');
});

test('ODM serialization fails closed for whitespace-delimited image basenames', () => {
  assert.throws(() => odmGcpList([{
    longitude: -88, latitude: 44, elevationM: 1, pixelX: 1, pixelY: 1,
    relativePath: 'image with spaces.jpg',
  }]), (error) => error.code === 'invalid_gcp_image_name');
  assert.throws(() => odmGcpList([{
    longitude: -88, latitude: 44, elevationM: 1, pixelX: 1, pixelY: 1,
    relativePath: 'image\tname.jpg',
  }]), (error) => error.code === 'invalid_gcp_image_name');
});
