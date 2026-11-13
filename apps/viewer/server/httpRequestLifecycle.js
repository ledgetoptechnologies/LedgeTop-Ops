'use strict';

const express = require('express');
const { METHODS } = require('node:http');
const PERMIT = Symbol('viewer HTTP admission');

// Tracks returned handler promises, not response/socket counts. Detached work
// must be registered with ownCallback before scheduling, or trackOwned before
// the current handler returns. Response closure alone is not promise settlement.
function createHttpRequestLifecycle() {
  let draining = false, responses = 0, work = 0;
  const waiters = new Set(), wrapped = new WeakMap(), wrappedParams = new WeakMap(), owned = new WeakMap();
  const notify = () => {
    if (draining && responses === 0 && work === 0) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
  };
  const refuse = res => {
    if (!res.destroyed && !res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error":"viewer is shutting down","code":"viewer_draining"}');
    }
  };
  function admission(req, res, next) {
    if (draining) return refuse(res);
    const permit = { owner: api, frames: 0, closed: false };
    req[PERMIT] = permit;
    responses++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; permit.closed = true; responses--; notify();
    };
    res.once('finish', close); res.once('close', close);
    next();
  }
  function retain(permit) {
    work++;
    if (permit) permit.frames++;
    let released = false;
    return () => {
      if (released) return;
      released = true; work--;
      if (permit) permit.frames--;
      notify();
    };
  }
  function wrap(handler, parameter = false) {
    if (Array.isArray(handler)) return handler.map(value => wrap(value, parameter));
    if (typeof handler !== 'function') return handler;
    const cache = parameter ? wrappedParams : wrapped;
    if (cache.has(handler)) return cache.get(handler);
    function tracked(...args) {
      const isError = !parameter && handler.length === 4;
      const req = args[isError ? 1 : 0], res = args[isError ? 2 : 1], next = args[isError ? 3 : 2];
      const permit = req?.[PERMIT];
      // A callback-style middleware may call next after its response has closed.
      // Once its permit has no owned frame left, no later handler may touch DB.
      if (draining && ((permit?.owner === api && permit.closed && permit.frames === 0)
          || permit?.owner !== api)) return refuse(res);
      const release = retain(permit?.owner === api ? permit : null);
      try {
        const result = handler.apply(this, args);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).then(value => { release(); return value; }, error => {
            try { next(error); } finally { release(); }
          });
        }
        release(); return result;
      } catch (error) {
        try { next(error); } finally { release(); }
      }
    }
    // Express distinguishes error middleware by arity; param handlers retain
    // their full argument list. Registration still uses public Express APIs.
    Object.defineProperty(tracked, 'length', { value: handler.length });
    cache.set(handler, tracked); cache.set(tracked, tracked);
    return tracked;
  }
  const methods = [...new Set([...METHODS.map(method => method.toLowerCase()), 'all', 'use', 'param'])];
  function decorate(target) {
    for (const method of methods) {
      if (typeof target[method] !== 'function') continue;
      const original = target[method];
      target[method] = function (...args) {
        return original.apply(this, args.map(value => wrap(value, method === 'param')));
      };
    }
    if (typeof target.route === 'function') {
      const route = target.route;
      target.route = function (...args) { return decorate(route.apply(this, args)); };
    }
    return target;
  }
  function ownCallback(callback) {
    if (draining) throw new Error('Cannot schedule new work during HTTP drain');
    const release = retain(null);
    let called = false;
    return function (...args) {
      if (called) return;
      called = true;
      try {
        const result = callback.apply(this, args);
        if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
        release(); return result;
      } catch (error) { release(); throw error; }
    };
  }
  function trackOwned(promise) {
    if (owned.has(promise)) return owned.get(promise);
    const release = retain(null);
    const tracked = Promise.resolve(promise).finally(release);
    owned.set(promise, tracked);
    return tracked;
  }
  const api = {
    admission,
    beginDrain() { draining = true; notify(); },
    waitForIdle() {
      if (!draining) throw new Error('Close HTTP admission before waiting for drain');
      if (responses === 0 && work === 0) return Promise.resolve();
      return new Promise(resolve => waiters.add(resolve));
    },
    ownCallback, trackOwned,
    trackedRouter(...args) { return decorate(express.Router(...args)); },
    snapshot() { return { draining, responses, work }; },
  };
  return api;
}

const httpRequestLifecycle = createHttpRequestLifecycle();
module.exports = { createHttpRequestLifecycle, httpRequestLifecycle, trackedRouter: (...args) => httpRequestLifecycle.trackedRouter(...args) };
