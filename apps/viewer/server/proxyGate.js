'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const HEADER_NAME = 'X-Viewer-Proxy-Secret';

function normalizedIp(value) {
  const raw = String(value || '').split('%', 1)[0];
  return raw.toLowerCase().startsWith('::ffff:') && net.isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
}

function parseTrustedProxyAddresses(value) {
  const entries = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const blockList = new net.BlockList();
  for (const entry of entries) {
    const [rawAddress, rawPrefix, extra] = entry.split('/');
    if (extra !== undefined) throw new Error(`invalid trusted proxy address: ${entry}`);
    const address = normalizedIp(rawAddress);
    const family = net.isIP(address);
    if (!family) throw new Error(`invalid trusted proxy address: ${entry}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (rawPrefix === undefined) blockList.addAddress(address, type);
    else {
      if (!/^\d{1,3}$/.test(rawPrefix)) throw new Error(`invalid trusted proxy CIDR: ${entry}`);
      const prefix = Number(rawPrefix), maximum = family === 4 ? 32 : 128;
      if (prefix < 0 || prefix > maximum) throw new Error(`invalid trusted proxy CIDR: ${entry}`);
      blockList.addSubnet(address, prefix, type);
    }
  }
  return {
    entries,
    allows(valueToCheck) {
      if (!entries.length) return true;
      const address = normalizedIp(valueToCheck), family = net.isIP(address);
      return Boolean(family && blockList.check(address, family === 4 ? 'ipv4' : 'ipv6'));
    },
  };
}

function constantTimeSecretEqual(expected, supplied) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(supplied || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function createProxyGate(config) {
  return (req, res, next) => {
    if (!config.production) return next();
    const host = String(req.headers.host || '').split(':', 1)[0].toLowerCase();
    if (host !== config.expectedHost) return res.status(421).json({ error: 'unexpected host' });
    if (!config.trustedProxyAllowlist.allows(req.socket.remoteAddress))
      return res.status(403).json({ error: 'proxy authentication required' });
    if (config.proxySharedSecret && !constantTimeSecretEqual(config.proxySharedSecret, req.get(HEADER_NAME)))
      return res.status(403).json({ error: 'proxy authentication required' });
    return next();
  };
}

module.exports = { HEADER_NAME, constantTimeSecretEqual, createProxyGate, normalizedIp, parseTrustedProxyAddresses };
