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

test('ODM serialization fails closed for ambiguous whitespace-delimited image names', () => {
  assert.throws(() => odmGcpList([{
    longitude: -88, latitude: 44, elevationM: 1, pixelX: 1, pixelY: 1,
    relativePath: 'image with spaces.jpg',
  }]), (error) => error.code === 'invalid_gcp_image_name');
});
