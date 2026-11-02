'use strict';
// Test-only snapshot of referenceProtocol.canonicalBytes from Viewer 7b8e9271.
// Main does not yet contain that module; integration must test the real export.
function canonicalBytes(value) {
  function encode(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) throw Error('canonical.integer');
      return String(v);
    }
    if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) throw Error('canonical.object');
    return '{' + Object.keys(v).sort().map(k => {
      if (!/^[\x20-\x7e]+$/.test(k)) throw Error('canonical.key');
      return JSON.stringify(k) + ':' + encode(v[k]);
    }).join(',') + '}';
  }
  return Buffer.from(encode(value), 'utf8');
}
module.exports = { canonicalBytes };
