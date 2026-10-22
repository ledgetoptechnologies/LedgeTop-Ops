'use strict';

const BASE_CONNECT_SOURCES = "'self' blob: https://server.arcgisonline.com";

function workspaceConnectSources(requestPath, opsBaseUrl, approvedOrigins=[opsBaseUrl], allowLoopback=false) {
  const pathname = String(requestPath || '').toLowerCase();
  if (pathname !== '/workspace' && pathname !== '/workspace.html' && !pathname.startsWith('/workspace/')) return BASE_CONNECT_SOURCES;
  try {
    const origin = new URL(opsBaseUrl);
    const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.origin !== opsBaseUrl || origin.hostname.includes('*') || (origin.protocol !== 'https:' && !localHttp)) return BASE_CONNECT_SOURCES;
    // Preserve the isolated loopback browser harness; runtime controller admission remains HTTPS-only.
    if(localHttp && approvedOrigins.length===1 && approvedOrigins[0]===opsBaseUrl)return `${BASE_CONNECT_SOURCES} ${origin.origin}`;
    const {controllerOrigins}=require('./controllerOrigins');
    const approved=controllerOrigins(opsBaseUrl,approvedOrigins.join(','),allowLoopback);
    if(!approved.length)return BASE_CONNECT_SOURCES;
    return `${BASE_CONNECT_SOURCES} ${approved.join(' ')}`;
  } catch {
    return BASE_CONNECT_SOURCES;
  }
}

module.exports = { workspaceConnectSources };
