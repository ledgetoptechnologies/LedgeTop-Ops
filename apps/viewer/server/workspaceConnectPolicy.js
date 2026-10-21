'use strict';

const BASE_CONNECT_SOURCES = "'self' blob: https://server.arcgisonline.com";

function workspaceConnectSources(requestPath, opsBaseUrl) {
  const pathname = String(requestPath || '').toLowerCase();
  if (pathname !== '/workspace' && pathname !== '/workspace.html' && !pathname.startsWith('/workspace/')) return BASE_CONNECT_SOURCES;
  try {
    const origin = new URL(opsBaseUrl);
    const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if (origin.origin !== opsBaseUrl || origin.hostname.includes('*') || (origin.protocol !== 'https:' && !localHttp)) return BASE_CONNECT_SOURCES;
    return `${BASE_CONNECT_SOURCES} ${origin.origin}`;
  } catch {
    return BASE_CONNECT_SOURCES;
  }
}

module.exports = { workspaceConnectSources };
