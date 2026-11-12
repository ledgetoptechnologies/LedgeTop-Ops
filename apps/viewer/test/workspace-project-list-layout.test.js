'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const css = readFileSync(path.join(__dirname, '..', 'workspace-project-list.css'), 'utf8');
const html = readFileSync(path.join(__dirname, '..', 'workspace.html'), 'utf8');

// Columns: chevron + 160px name + 96/104/112px tracks + gaps/padding is about
// 570px; the side-by-side action column is 380px. Together they need ~950px.
const TOGGLE_MIN = 570, ACTIONS = 380;

test('task row layout is sized by the task list, not the viewport, so the sidebar cannot squeeze it', () => {
  assert.match(css, /\.task-list\{container-type:inline-size\}/);
  assert.doesNotMatch(css, /@media\([^)]*min-width:1101px\)/, 'the old viewport breakpoint must not size task rows');
  assert.doesNotMatch(css, /@media[^{]*\{[^@]*\.task-summary\{grid-template-columns:minmax\(0,1fr\) 380px\}/, 'side-by-side actions are only set inside a container query');
});

test('side-by-side actions only switch on when the list fits both the summary and the actions', () => {
  const wide = css.match(/@container \(min-width:(\d+)px\)\{\s*\.task-summary\{grid-template-columns:minmax\(0,1fr\) (\d+)px\}/);
  assert.ok(wide, 'side-by-side container rule missing');
  const [, threshold, actions] = wide.map(Number);
  assert.equal(actions, ACTIONS);
  assert.ok(threshold >= TOGGLE_MIN + ACTIONS, `threshold ${threshold}px must cover ${TOGGLE_MIN + ACTIONS}px`);
  assert.match(css, new RegExp(`@container \\(min-width:600px\\) and \\(max-width:${threshold - 1}\\.98px\\)\\{\\s*\\.task-summary\\{grid-template-columns:minmax\\(0,1fr\\)\\}`), 'narrower lists stack the actions under the summary');
});

test('the project list stylesheet loads after the management stylesheet it overrides', () => {
  const management = html.indexOf('/workspace-management.css'), list = html.indexOf('/workspace-project-list.css');
  assert.ok(management > 0 && list > management);
});
