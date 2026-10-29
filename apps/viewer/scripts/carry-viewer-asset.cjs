'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ASSET = 'viewer-gZcdd1xa.js';
const SHA256 = '0e2b39ee1c862b2bb732f594026907a277ba98a5f4a146492e7e485b2114f7c3';
const digest = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

function carryVerifiedAsset(source, dist) {
  if (!fs.lstatSync(source).isFile() || digest(source) !== SHA256) throw new Error('retained Viewer asset hash mismatch');
  if (!fs.lstatSync(dist).isDirectory()) throw new Error('Viewer dist directory is not a directory');
  const realDist = fs.realpathSync(dist);
  const dir = path.join(dist, 'assets');
  try { fs.mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(dir).isDirectory() || path.dirname(fs.realpathSync(dir)) !== realDist)
    throw new Error('Viewer assets directory escapes dist');
  const destination = path.join(dir, ASSET);
  try {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.lstatSync(destination).isFile() || digest(destination) !== SHA256) throw new Error('retained Viewer asset path collision');
  }
  if (digest(destination) !== SHA256) throw new Error('retained Viewer asset verification failed');
  return destination;
}

if (require.main === module) carryVerifiedAsset(path.join(__dirname, '..', 'release-assets', ASSET), path.join(__dirname, '..', 'dist'));
module.exports = { ASSET, SHA256, carryVerifiedAsset };
