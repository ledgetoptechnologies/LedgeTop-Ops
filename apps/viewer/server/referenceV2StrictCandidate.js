'use strict';
// Synthetic, unmounted metadata codec. It grants no authority and is not an endpoint.
const { TextDecoder } = require('node:util');
const LIMITS = Object.freeze({ bytes: 4194304, depth: 32, array: 10000, object: 256 });
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
function decodeV2Metadata(bytes) {
  const fail = () => { throw new Error('invalid_v2_metadata'); };
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.bytes || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail();
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  let pos = 0;
  const ws = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  function string() {
    const start = pos++;
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '\\') { if (pos >= text.length) fail(); pos++; continue; }
      if (ch === '"') {
        let value; try { value = JSON.parse(text.slice(start, pos)); } catch { fail(); }
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
        return value;
      }
    }
    fail();
  }
  function value(depth) {
    ws(); const ch = text[pos];
    if (ch === '"') return string();
    if (ch === '{' || ch === '[') {
      if (depth >= LIMITS.depth) fail(); pos++; ws();
      const object = ch === '{', result = object ? {} : [], seen = new Set();
      const end = object ? '}' : ']'; if (text[pos] === end) { pos++; return result; }
      let count = 0;
      while (true) {
        if (++count > (object ? LIMITS.object : LIMITS.array)) fail();
        if (object) {
          if (text[pos] !== '"') fail(); const key = string();
          if (seen.has(key) || UNSAFE.has(key) || !/^[\x20-\x7e]+$/.test(key)) fail();
          seen.add(key); ws(); if (text[pos++] !== ':') fail();
          Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        } else result.push(value(depth + 1));
        ws(); if (text[pos] === end) { pos++; return result; }
        if (text[pos++] !== ',') fail(); ws();
      }
    }
    for (const [token, item] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, pos)) { pos += token.length; return item; }
    }
    const match = /^(?:0|[1-9][0-9]*)/.exec(text.slice(pos));
    if (!match) fail(); pos += match[0].length;
    const number = Number(match[0]); if (!Number.isSafeInteger(number)) fail(); return number;
  }
  const result = value(0); ws(); if (pos !== text.length) fail(); return result;
}
// Only identifies the spool profile. Closed schema and authority checks remain mandatory.
function requireSpoolV2Profile(record, receiptType) {
  const types = new Set(['processing_spool_custody_v2', 'source_release_authorization_v2', 'source_release_ack_v2']);
  if (!types.has(receiptType) || !record || Array.isArray(record) || typeof record !== 'object' || record.protocol !== 'ltds-processing-spool-v2' || record.schemaVersion !== 2 || record.receiptType !== receiptType) throw new Error('invalid_v2_profile');
  return record;
}
module.exports = { decodeV2Metadata, requireSpoolV2Profile, LIMITS };
