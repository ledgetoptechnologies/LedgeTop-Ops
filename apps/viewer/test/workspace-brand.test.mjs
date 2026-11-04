import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');

test('the favicon data URI is one intact attribute value holding the whole LT mark', () => {
  const link = html.match(/<link rel="icon" href="([^"]*)" type="image\/svg\+xml">/);
  assert.ok(link, 'favicon link must parse with a double-quoted href and the svg type after it');
  const svg = decodeURIComponent(link[1].replace(/^data:image\/svg\+xml,/, ''));
  assert.match(svg, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='238\.5 226 776 776'>/);
  assert.match(svg, /stroke='#ee5007'/);
  assert.match(svg, /<\/svg>$/);
});

test('the workspace uses Ledge Top branding without the remote LTDS logo', () => {
  assert.match(html, /<title>Ledge Top Viewer<\/title>/);
  assert.match(html, /<svg class="brand-mark" viewBox="238\.5 226 776 776" aria-hidden="true"/);
  assert.doesNotMatch(html, /ledgetopdroneservices\.com|DroneLogo|LTDS Viewer/);
});
