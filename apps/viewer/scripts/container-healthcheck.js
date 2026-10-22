'use strict';

const http = require('node:http');
const { config } = require('../server/config');
const { HEADER_NAME } = require('../server/proxyGate');

const request = http.get({
  host: '127.0.0.1',
  port: config.port,
  path: '/api/v1/ready',
  timeout: 4000,
  headers: { Host: config.expectedHost, ...(config.proxySharedSecret ? { [HEADER_NAME]: config.proxySharedSecret } : {}) },
}, (response) => {
  response.resume();
  response.once('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.once('timeout', () => request.destroy(new Error('healthcheck timeout')));
request.once('error', () => process.exit(1));
