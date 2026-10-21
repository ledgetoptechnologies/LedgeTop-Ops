'use strict';

const net = require('node:net');

function addressFamily(value) {
  const address = String(value || '').replace(/^\[|\]$/g, '');
  const version = net.isIP(address);
  return { address, family: version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null };
}

function blockList(entries, family) {
  const list = new net.BlockList();
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, family);
  return list;
}

// These addresses are never valid processing nodes, even when a broad operator
// CIDR or an exact origin would otherwise match. Private RFC1918 and IPv6 ULA
// space deliberately remain available for on-premises NodeODM/ClusterODM.
const forbiddenIpv4 = blockList([
  ['0.0.0.0', 8],       // unspecified/current network
  ['100.64.0.0', 10],   // shared address space
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local and common metadata endpoints
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // documentation
  ['192.88.99.0', 24],  // deprecated 6to4 relay
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24],  // documentation
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved/broadcast
], 'ipv4');

const forbiddenIpv6 = blockList([
  ['::', 128],          // unspecified
  ['::1', 128],         // loopback
  ['::ffff:0:0', 96],   // IPv4-mapped addresses (avoid family ambiguity)
  ['64:ff9b:1::', 48],  // local-use translation prefix
  ['100::', 64],        // discard-only
  ['2001::', 32],       // Teredo
  ['2001:10::', 28],    // ORCHID
  ['2001:20::', 28],    // ORCHIDv2
  ['2001:db8::', 32],   // documentation
  ['fe80::', 10],       // link-local
  ['ff00::', 8],        // multicast
], 'ipv6');

function parseProviderCidrs(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry) => {
    const text = String(entry).trim();
    const slash = text.lastIndexOf('/');
    if (slash <= 0 || !/^\d{1,3}$/.test(text.slice(slash + 1)))
      throw new Error(`contains invalid CIDR: ${text}`);
    const { address, family } = addressFamily(text.slice(0, slash));
    const prefix = Number(text.slice(slash + 1));
    const maxPrefix = family === 'ipv4' ? 32 : family === 'ipv6' ? 128 : -1;
    if (!family || prefix < 0 || prefix > maxPrefix)
      throw new Error(`contains invalid CIDR: ${text}`);
    const matcher = new net.BlockList();
    try { matcher.addSubnet(address, prefix, family); }
    catch { throw new Error(`contains invalid CIDR: ${text}`); }
    return Object.freeze({ text, address, family, prefix, matcher });
  });
}

function canonicalProviderEndpoint(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    const host = addressFamily(url.hostname);
    const hostname = host.address.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost'))
      return { origin: url.origin, hostname, family: null, forbidden: true };
    const forbidden = host.family === 'ipv4'
      ? forbiddenIpv4.check(host.address, 'ipv4')
      : host.family === 'ipv6' && forbiddenIpv6.check(host.address, 'ipv6');
    return { origin: url.origin, hostname: host.address, family: host.family, forbidden: Boolean(forbidden) };
  } catch {
    return null;
  }
}

function admitProviderEndpoint(value, { exactOrigins = [], allowedCidrs = [] } = {}) {
  const endpoint = canonicalProviderEndpoint(value);
  if (!endpoint) return { ok: false, code: 'invalid_provider_endpoint' };
  if (endpoint.forbidden) return { ok: false, code: 'provider_origin_not_allowed' };
  if (exactOrigins.includes(endpoint.origin)) return { ok: true, origin: endpoint.origin, admission: 'exact_origin' };
  if (endpoint.family && allowedCidrs.some((cidr) => cidr.family === endpoint.family
    && cidr.matcher.check(endpoint.hostname, endpoint.family)))
    return { ok: true, origin: endpoint.origin, admission: 'cidr' };
  return { ok: false, code: 'provider_origin_not_allowed' };
}

module.exports = { admitProviderEndpoint, canonicalProviderEndpoint, parseProviderCidrs };
