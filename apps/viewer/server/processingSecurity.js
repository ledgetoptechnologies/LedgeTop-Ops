'use strict';

const path = require('node:path');

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function sanitizeLogMessage(value) {
  return String(value || '')
    .replace(/([?&](?:token|secret|signature|key|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:token|secret|signature|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED AUTHORIZATION]')
    .replace(/(?:\b[A-Za-z]:\\|\/mnt\/|\/home\/|\/app\/)[^\s"']+/g, '[REDACTED PATH]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 64 * 1024);
}

function publicDerivativeKind(kind) {
  // Original datasets, provider archives, OBJ sources, LAZ/PLY point clouds,
  // logs and processing internals are administrative assets. Only selected,
  // reviewed derivatives may become client/public assets.
  // Camera positions are a reviewed display companion. Their linked photos
  // remain separately authorized by exact filename and integrity record.
  return new Set(['glb','tiles','ept','ortho','orthoCutline','dsm','dtm','shots']).has(kind);
}

function adminOutputAssetKind(kind) {
  // Reports are useful to staff but are not part of the client/public model
  // derivative allowlist. Raw provider inputs remain excluded from both.
  return publicDerivativeKind(kind) || kind === 'report';
}

module.exports = { adminOutputAssetKind, compareUtf8, publicDerivativeKind, safeRelativePath, sanitizeLogMessage };
