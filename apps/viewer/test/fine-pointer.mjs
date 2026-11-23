import assert from 'node:assert/strict';

// Headless Chromium on a machine with no input devices (GitHub's Linux
// runners) reports pointer:none and hover:none, so CSS gated on
// `(pointer:fine)` never applies there. This switch makes a mouse the primary
// and only pointer, with hover; Playwright adds the same one to headless
// Chromium. Blink enum values: PointerType fine = 4, HoverType hover = 2.
// DevTools touch emulation (Emulation.setTouchEmulationEnabled) still
// switches the page to a coarse pointer and restores fine when disabled.
export const FINE_POINTER_SWITCH = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';

const queries = ['(pointer: fine)', '(hover: hover)', '(any-pointer: fine)', '(pointer: coarse)', '(pointer: none)'];
const expected = { '(pointer: fine)': true, '(hover: hover)': true, '(any-pointer: fine)': true, '(pointer: coarse)': false, '(pointer: none)': false };

// Fails loudly when the browser was launched without FINE_POINTER_SWITCH (or
// it stopped working), instead of letting desktop checks measure phone CSS.
export async function assertFinePointer(evaluate, label = 'browser') {
  const media = await evaluate(`Object.fromEntries(${JSON.stringify(queries)}.map(query=>[query,matchMedia(query).matches]))`);
  assert.deepEqual(media, expected, `${label}: expected a desktop fine pointer with hover; launch Chromium with FINE_POINTER_SWITCH`);
}
