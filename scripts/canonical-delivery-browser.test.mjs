import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '../apps/client/node_modules/playwright/index.mjs';
import { canonicalDeliveryEntryRedirect } from '../apps/client/src/worker/canonical-delivery-routing.ts';
const OLD='https://portal.ledgetopdroneservices.com', NEW='https://delivery.ledgetop.app';
const env={ENVIRONMENT:'production',EXPECTED_HOST:'delivery.ledgetop.app',PUBLIC_BASE_URL:NEW,PUBLIC_SHARE_ORIGIN:NEW,
  CLIENT_PORTAL_ORIGIN:'https://portal.ledgetop.app',CLIENT_PORTAL_ORIGINS:`https://portal.ledgetop.app,${OLD}`,
  LEGACY_CLIENT_ORIGINS:`${OLD},https://client.ledgetopdroneservices.com`,CLIENT_PORTAL_RETIRED_ORIGINS:''};

test('Chromium inherits private fragments through the real HTTP redirect response',async()=>{
  // Both listeners bind loopback only. Production origin policy is tested with
  // synthetic Request objects, then Location's authority is mapped to loopback
  // for the browser's actual HTTP redirect/fragment behavior. No live traffic.
  const received=[];
  const target=createServer((req,res)=>{received.push(req.url);res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Synthetic acceptance</title>');});
  target.listen(0,'127.0.0.1'); await once(target,'listening');
  const targetOrigin=`http://127.0.0.1:${target.address().port}`;
  const source=createServer((req,res)=>{
    const response=canonicalDeliveryEntryRedirect(new Request(`${OLD}${req.url}`,{headers:req.headers}),env,true);
    if(!response){res.writeHead(500);res.end('unexpected policy denial');return;}
    const location=new URL(response.headers.get('Location'));
    res.writeHead(response.status,{...Object.fromEntries(response.headers),location:`${targetOrigin}${location.pathname}${location.search}`});res.end();
  });
  source.listen(0,'127.0.0.1'); await once(source,'listening');
  const sourceOrigin=`http://127.0.0.1:${source.address().port}`;
  let browser;
  try {
    browser=await chromium.launch({headless:true, ...(process.env.CANONICAL_DELIVERY_BROWSER_CHANNEL === 'msedge' ? {channel:'msedge'} : {})});
    const page=await browser.newPage();
    for(const root of ['s','client-share']) {
      const path=`/${root}/synthetic-id?folder=opaque%2Fref&sort=name&sort=date`;
      await page.goto(`${sourceOrigin}${path}#Synthetic_secret-123`);
      assert.equal(page.url(),`${targetOrigin}${path}#Synthetic_secret-123`);
      assert.ok(received.includes(path));
      assert.equal(received.some(value=>value.includes('Synthetic_secret')),false);
    }
  } finally {if(browser) await browser.close(); await Promise.all([new Promise(resolve=>source.close(resolve)),new Promise(resolve=>target.close(resolve))]);}
});
