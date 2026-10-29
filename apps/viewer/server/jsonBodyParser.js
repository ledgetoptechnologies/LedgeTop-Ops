'use strict';

const express = require('express');
const auth = require('./auth');

function presentedAdmin(processing, req) {
  const token=String(req.get('authorization')||'').match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i)?.[1];
  if(!token)return null;
  const session=processing.getAdminSessionByHash(auth.hashToken(token));
  return !session||session.revokedAt ? null : {token,session};
}
function liveAdmin(processing, req) {
  const presented=presentedAdmin(processing,req);
  return presented&&processing.adminSessionLive(presented.session) ? presented.session : null;
}

// Larger bodies are accepted only on the manifest-creation route. Keep the
// original body bytes for service HMAC verification on both parsers.
function installJsonBodyParsers(app, config, processing) {
  const verify = (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); };
  const upload = express.json({ limit: config.uploadMaxManifestBytes, verify });
  let active = false;
  app.use((req, res, next) => {
    if (config.processingPlatformEnabled && req.method === 'POST' && /^\/api\/v1\/datasets\/[^/]+\/uploads\/?$/i.test(req.path)) {
      const principal=liveAdmin(processing,req);
      if(!principal||!principal.permissions.includes('viewer.datasets.write')) {
        req.resume();res.setHeader('Cache-Control','no-store');res.setHeader('Connection','close');
        return res.status(principal?403:401).json({error:principal?'permission denied':'authentication required',code:principal?'permission_denied':'authentication_required'});
      }
      if(active){req.resume();res.setHeader('Cache-Control','no-store');res.setHeader('Connection','close');res.setHeader('Retry-After','2');return res.status(429).json({error:'upload manifest busy',code:'upload_manifest_busy'});}
      active=true;let released=false;
      const timer=setTimeout(()=>req.destroy(),120000);timer.unref();
      const release=()=>{if(released)return;released=true;active=false;clearTimeout(timer);};
      res.once('finish',release);res.once('close',release);
      return upload(req,res,next);
    }
    return next();
  });
  app.use(express.json({ limit: config.processingPlatformEnabled ? config.genericJsonMaxBytes : '100kb', verify }));
}

module.exports = { installJsonBodyParsers, presentedAdmin, liveAdmin };
