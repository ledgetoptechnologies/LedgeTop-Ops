// Merge parcels by owner: which owner names count as one owner, and what a
// parcel with no listed owner shows. Synthetic parcels and generic owner
// names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_OWNER_LABEL, dissolveParcelsByOwner, formatParcelArea, normalizeOwnerName, ownerLabelCandidates, placeOwnerLabels,
} from '../property-lines-owners.mjs';

const LON0 = -89.74, LAT0 = 44.81, STEP = 0.002;
const corner = (i, j) => [Math.round((LON0 + i * STEP) * 1e7) / 1e7, Math.round((LAT0 + j * STEP) * 1e7) / 1e7];
const square = (i, j, w = 1, h = 1) => [corner(i, j), corner(i, j + h), corner(i + w, j + h), corner(i + w, j), corner(i, j)];
const parcel = (id, owner, ring, acres) => ({ id, rings: [ring], ...(owner == null ? {} : { owner }), ...(acres ? { acres } : {}) });
const all = () => true;
const projectAt = zoom => (lon, lat) => {
  const n = 256 * 2 ** zoom, at = (lo, la) => [(lo + 180) / 360 * n, (1 - Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)) / Math.PI) / 2 * n];
  const [x, y] = at(lon, lat), [x0, y0] = at(LON0, LAT0);
  return [x - x0 + 1000, y - y0 + 1000];
};
const measure = (line, px) => line.length * px * 0.6;
const labelsFor = (parcels, merge, zoom = 17) => placeOwnerLabels(
  ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge }), { acreage: { merged: merge, covered: all } }),
  { zoom, project: projectAt(zoom), viewport: { width: 3000, height: 3000 }, measure });
const noOverlap = labels => {
  for (const [i, a] of labels.entries()) for (const b of labels.slice(i + 1))
    assert.ok(Math.abs(a.x - b.x) * 2 >= a.width + b.width || Math.abs(a.y - b.y) * 2 >= a.height + b.height, `${a.lines} / ${b.lines} overlap`);
};

test('owner match: case, punctuation, "&" and trust wording do not matter', () => {
  const same = [
    ['JOHN Q SAMPLE', 'john q. sample'],
    ['JOHN & MARY SAMPLE', 'JOHN AND MARY SAMPLE'],
    ['JOHN Q SAMPLE REV TRST', 'JOHN Q SAMPLE REVOCABLE TRUST'],
    ['JOHN Q SAMPLE', 'JOHN Q SAMPLE LIVING TRUST'],
    ['JOHN Q SAMPLE', 'THE JOHN Q SAMPLE TRUST'],
    ['JOHN Q SAMPLE TR', 'JOHN Q SAMPLE TTEE'],
    ["MARY O'EXAMPLE", 'MARY OEXAMPLE'],
    ['MARY SAMPLE-EXAMPLE', 'MARY SAMPLE EXAMPLE'],
    ['SAMPLE FAMILY TRUST', 'SAMPLE FAMILY REV TRUST'],
  ];
  for (const [a, b] of same) assert.equal(normalizeOwnerName(a), normalizeOwnerName(b), `${a} = ${b}`);
});

test('owner match: different people never match', () => {
  const different = [
    ['JOHN Q SAMPLE', 'JANE Q SAMPLE'],
    ['JOHN Q SAMPLE', 'JOHN Q SAMPLE JR'],
    ['JOHN Q SAMPLE SR', 'JOHN Q SAMPLE JR'],
    ['JOHN Q SAMPLE', 'JOHN SAMPLE'],
    ['JOHN Q SAMPLE', 'JOHN Q SAMPLE ET AL'],
    ['SAMPLE FAMILY TRUST', 'SAMPLE'],
    ['SAMPLE TRUST', 'SAMPLE'],
    ['JOHN & MARY SAMPLE', 'JOHN SAMPLE'],
    ['SAMPLE FARMS LLC', 'SAMPLE FARMS INC'],
  ];
  for (const [a, b] of different) assert.notEqual(normalizeOwnerName(a), normalizeOwnerName(b), `${a} != ${b}`);
  for (const placeholder of ['NOT AVAILABLE', 'UNKNOWN OWNER', 'N/A']) assert.equal(normalizeOwnerName(placeholder), '', placeholder);
});

test('merge: one owner written two ways becomes one outline with the summed stated acres', () => {
  const parcels = [
    parcel(1, 'JOHN Q SAMPLE', square(0, 0, 2, 2), 7.5),
    parcel(2, 'John Q. Sample Rev Trust', square(2, 0, 2, 2), 12.25),
    parcel(3, 'JANE Q SAMPLE', square(0, 2, 4, 1), 9),
  ];
  const merged = dissolveParcelsByOwner(parcels);
  assert.equal(merged.length, 2, 'the two spellings merge; the other person does not');
  const labels = labelsFor(parcels, true);
  const area = labels.map(l => l.lines.at(-1)).sort();
  assert.deepEqual(area, ['19.8 ac', '9.0 ac']);
  // The name shown does not depend on which record arrived first.
  const reversed = labelsFor([parcels[1], parcels[0], parcels[2]], true);
  assert.deepEqual(reversed.map(l => l.lines).sort(), labels.map(l => l.lines).sort());
  noOverlap(labels);
});

test('a parcel with no listed owner next to a named one keeps its outline, acreage and an owner-not-listed label', () => {
  // A named lot with stated acres beside a large lot with no owner and no stated acres.
  const parcels = [parcel(1, 'JOHN Q SAMPLE', square(3, 0, 2, 2), 7.5), parcel(2, null, square(0, 0, 3, 4)), parcel(3, 'JOHN Q SAMPLE', square(3, 2, 2, 2), 8)];
  for (const merge of [false, true]) {
    const outlines = dissolveParcelsByOwner(parcels, { merge });
    assert.equal(outlines.length, merge ? 2 : 3);
    assert.ok(outlines.some(o => o.parcelIds.includes(2) && o.parcelIds.length === 1), 'the unowned lot is its own outline');
    const labels = labelsFor(parcels, merge);
    const unknown = labels.filter(l => l.lines[0] === UNKNOWN_OWNER_LABEL);
    assert.equal(unknown.length, 1, `merge ${merge}: one owner-not-listed label`);
    assert.equal(unknown[0].unknownOwner, true);
    assert.match(unknown[0].lines[1], /^~\d/, 'computed acreage, marked approximate');
    assert.ok(labels.some(l => l.lines[0] === 'JOHN Q SAMPLE'), 'the named land keeps its name');
    noOverlap(labels);
  }
  assert.equal(UNKNOWN_OWNER_LABEL, 'Owner not listed');
  assert.equal(formatParcelArea(4046.8564224 * 15.5, 'imperial', { approx: false }), '15.5 ac');
});

test('stacked records over the same land never give stacked labels', () => {
  const ring = square(0, 0, 3, 3);
  const parcels = [parcel(1, 'UNIT OWNER A', ring), parcel(2, 'UNIT OWNER B', ring), parcel(3, null, ring), parcel(4, null, square(3, 0, 3, 3))];
  for (const merge of [false, true]) {
    const labels = labelsFor(parcels, merge);
    noOverlap(labels);
    assert.ok(labels.length >= 2, `merge ${merge}: ${labels.length} labels`);
  }
});

test('an uploaded boundary file (no owners at all) gets no owner-not-listed labels', () => {
  const parcels = [parcel(1, null, square(0, 0, 3, 3)), parcel(2, null, square(3, 0, 3, 3))];
  assert.deepEqual(ownerLabelCandidates(dissolveParcelsByOwner(parcels)), []);
});
