'use strict';

const express = require('express');
const auth = require('./auth');
const { config } = require('./config');

const COOKIE_NAME = 'ltds_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function isAdminRequest(req) {
  if (!config.emergencyAdminEnabled) return false;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    if (config.adminPassword && auth.constantTimeEqual(token, config.adminPassword)) return true;
  }
  const cookieVal = req.cookies && req.cookies[COOKIE_NAME];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  return !!(payload && payload.role === 'admin');
}

function requireAdmin(req, res, next) {
  if (!config.emergencyAdminEnabled) return res.status(404).json({ error: 'legacy administration is disabled; use LTDS Ops' });
  if (isAdminRequest(req)) return next();
  res.status(401).json({ error: 'admin authentication required' });
}

const router = express.Router();

router.use('/api/admin', (_req, res, next) => {
  if (config.emergencyAdminEnabled) return next();
  return res.status(404).json({ error: 'legacy administration is disabled; use LTDS Ops' });
});

router.post('/api/admin/login', (req, res) => {
  if (auth.rateLimited(`admin-login:${req.ip}`, 10, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const password = (req.body && req.body.password) || '';
  if (!config.adminPassword || !auth.constantTimeEqual(password, config.adminPassword)) {
    return res.status(401).json({ error: 'invalid password' });
  }
  const cookieVal = auth.sign({ role: 'admin' }, SESSION_TTL_MS);
  res.cookie(COOKIE_NAME, cookieVal, auth.cookieAttrs(req, { maxAge: SESSION_TTL_MS }));
  res.json({ ok: true });
});

router.post('/api/admin/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: isAdminRequest(req) });
});

module.exports = { router, requireAdmin, isAdminRequest, COOKIE_NAME };
