import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../workspace.css', import.meta.url), 'utf8');

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

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

test('workspace accent text and keyboard focus preserve accessible contrast', () => {
  const root = css.match(/:root\{([^}]+)\}/)?.[1];
  assert.ok(root, 'workspace root tokens must be present');
  const token = name => root.match(new RegExp(`--${name}:([^;]+)`))?.[1];
  const hex = value => value?.match(/#[0-9a-f]{6}/i)?.[0];
  const foreground = hex(token('surface-0'));
  const base = hex(token('orange'));
  const pressed = hex(token('orange-pressed'));
  const focus = hex(token('orange-bright'));
  assert.equal(token('on-accent'), 'var(--surface-0)');
  assert.ok(contrast(foreground, base) >= 4.5, 'accent text on base orange must meet 4.5:1');
  assert.ok(contrast(foreground, pressed) >= 4.5, 'accent text on pressed orange must meet 4.5:1');
  assert.ok(contrast(focus, foreground) >= 3, 'focus ring must meet 3:1 against the dark surface');
  assert.match(css, /\.primary-button:focus-visible,\.skip-link:focus-visible\{outline:2px solid var\(--orange-bright\);outline-offset:2px;box-shadow:none\}/);
});
