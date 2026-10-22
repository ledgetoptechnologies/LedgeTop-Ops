(function exposePointCloudDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudDisplay = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function pointCloudDisplayFactory() {
  'use strict';

  // LAS classification values, not a prediction from RGB, elevation, or position.
  // 8 and 12 changed meaning between older LAS formats and LAS 1.4, so do not
  // present an unqualified class name when the source version is unavailable.
  const CLASS_NAMES = Object.freeze({
    0: 'Never classified', 1: 'Unclassified', 2: 'Ground',
    3: 'Low vegetation', 4: 'Medium vegetation', 5: 'High vegetation',
    6: 'Building', 7: 'Low noise', 8: 'Legacy key-point / reserved',
    9: 'Water', 10: 'Rail', 11: 'Road surface', 12: 'Legacy overlap / reserved',
    13: 'Wire guard', 14: 'Wire conductor', 15: 'Transmission tower',
    16: 'Wire-structure connector', 17: 'Bridge deck', 18: 'High noise',
    19: 'Overhead structure', 20: 'Ignored ground', 21: 'Snow', 22: 'Temporal exclusion',
  });

  function classificationLabel(point) {
    if (!point) return 'Classification: —';
    const attribute = point.classification;
    const value = Array.isArray(attribute) || ArrayBuffer.isView(attribute) ? attribute[0] : attribute;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
      return 'Classification: unavailable';
    }
    return `Classification: ${CLASS_NAMES[value] || 'Unknown / user-defined'} (${value})`;
  }

  // One trailing pick after pointer motion settles. GPU picking reads pixels;
  // never run it in the render loop, during a drag, or once per pointer event.
  function createHoverReader({ pick, canPick, show, schedule = setTimeout, cancel = clearTimeout, delay = 180 }) {
    let pending = null;
    let generation = 0;
    function clear() {
      generation++;
      if (pending !== null) cancel(pending);
      pending = null;
      show('Classification: —');
    }
    return Object.freeze({
      clear,
      move(event) {
        clear();
        if (event.buttons || event.pointerType === 'touch' || !canPick()) return;
        const position = { x: event.clientX, y: event.clientY };
        const expected = generation;
        pending = schedule(() => {
          pending = null;
          if (generation !== expected || !canPick()) return;
          let point = null;
          try { point = pick(position); } catch { /* undecoded or disposed nodes */ }
          if (generation === expected) show(classificationLabel(point));
        }, delay);
      },
    });
  }

  return Object.freeze({ CLASS_NAMES, classificationLabel, createHoverReader });
}));
