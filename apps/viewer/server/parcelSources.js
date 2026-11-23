'use strict';

// Registry of public parcel services the property-lines layer may query.
// The server picks the first source whose published extent touches the
// model's location (propertyLines.js); a model outside every extent has no
// state source and gets status 'outside', and a project's uploaded boundary
// file always takes precedence over any state source.
//
// Adding a state is config only: append one frozen object to PARCEL_SOURCES.
//   1. Confirm in writing that the state's parcel data may be shown to every
//      viewer audience (staff, clients and public links). Do not add a state
//      before that.
//   2. Read the layer's metadata (`<layerUrl>?f=json`): it must be a polygon
//      Feature Layer whose native spatial reference is Web Mercator
//      (102100 / 3857); the fetcher inverts spherical Mercator itself and
//      never asks the service to reproject. Note its id field and extent.
//   3. Fill every field below. `query.outFields` must be exactly the
//      fields approved for this source in APPROVED_PARCEL_FIELDS (below): the
//      id field, then the owner-name field (`query.ownerField`) if approved.
//      Nothing else ever leaves the state service: no address, value or other
//      attribute. Adding a source or a field needs an approval recorded
//      there. The owner name labels the parcels and merges touching parcels
//      of one owner in the Viewer. `extent` is the layer's
//      published extent as lon/lat rounded outward. Order matters: extents
//      are rectangles and neighbouring states overlap, so the first match wins.
//   4. Fill `shortName`, `vintage` and `dataUpdated` from the layer: its
//      release, the tax-roll year most rows carry, and its
//      editingInfo.dataLastEditDate as YYYY-MM-DD. They record what is loaded
//      (the offer response carries them); the panel does not show them.
//   5. Optional `discovery` lets scripts/check-parcel-releases.mjs look for a
//      newer release each month. It only reports; a person or agent updates
//      layerUrl, release, vintage, dataUpdated and discovery.currentVersion
//      here after checking the new release's fields.
//   6. Add tests for the new source's selection and request.
//
// Field reference:
//   id            stable source id returned to the browser.
//   region        human name of the covered region.
//   name, release, credit, disclaimer, datumNote   shown in the Viewer.
//   shortName     short region label for the panel ('WI statewide').
//   vintage       release and tax-roll year in words ('V12, 2025 tax roll').
//   dataUpdated   the layer's last data edit, YYYY-MM-DD.
//   datum         horizontal datum of the source data ('NAD83').
//   layerUrl      ArcGIS Feature Layer URL (https, no query string).
//   extent        { west, south, east, north } in lon/lat degrees.
//   query         { idField, ownerField?, outFields, wkid, where, geometryPrecision }.
//   discovery     optional release-discovery rule (see check-parcel-releases.mjs):
//                 { kind: 'arcgis-org', currentVersion, portalUrl, orgId,
//                   servicesDirectory, searchText, namePattern, versionPatterns }.

const PARCEL_DISCLAIMER = 'Property lines are approximate and for reference only. They are not a survey and do not show legal ownership boundaries. No warranty of accuracy, completeness or currency is made. Only a licensed land surveyor can determine a boundary.';

// Release V12 (2026). The state publishes a new version each year; the
// monthly release check opens an issue when it sees one. Update layerUrl,
// release, vintage, dataUpdated, credit and discovery.currentVersion together
// after checking it. V12 rows carry the 2025 tax roll (TAXROLLYEAR) and the
// layer's data was last edited on 2026-06-30 (editingInfo.dataLastEditDate,
// read 2026-11-22).
const WISCONSIN = Object.freeze({
  id: 'wi-statewide-parcels',
  region: 'Wisconsin',
  name: 'Wisconsin Statewide Parcel Map',
  release: 'V12 (2026)',
  shortName: 'WI statewide',
  vintage: 'V12, 2025 tax roll',
  dataUpdated: '2026-06-30',
  credit: "Product of the Version 12 Statewide Parcel Map Database Project (V12). Created by the Wisconsin State Cartographer's Office; administered by the Wisconsin Land Information Program at the Department of Administration.",
  disclaimer: PARCEL_DISCLAIMER,
  datum: 'NAD83',
  datumNote: 'The state data is NAD83-based and is drawn with no datum shift. Against a model in a WGS84 or ITRF-based frame, expect roughly 1 to 1.5 m of offset in Wisconsin, within the parcel map\u2019s own accuracy.',
  layerUrl: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0',
  // Layer extent published by the service (Web Mercator xmin -10340314.53,
  // ymin 5234954.18, xmax -9658524.28, ymax 5955260.21), as lon/lat rounded
  // outward.
  extent: Object.freeze({ west: -92.89, south: 42.49, east: -86.76, north: 47.09 }),
  // OWNERNME1 is the first owner name. The state confirmed in writing on
  // 2026-11-18 that the statewide parcel data is public domain.
  query: Object.freeze({ idField: 'OBJECTID', ownerField: 'OWNERNME1', outFields: 'OBJECTID,OWNERNME1', wkid: 3857, where: '1=1', geometryPrecision: 2 }),
  // The service name carries no version. The version shows in the layer name
  // (V1200_WisconsinParcels_2026), the item's tags ("V12 Parcels", cumulative)
  // and its summary ("Version 12.0.0"). A new release may replace the layer in
  // place or arrive as a new service in the same ArcGIS organisation.
  discovery: Object.freeze({
    kind: 'arcgis-org',
    currentVersion: 12,
    portalUrl: 'https://www.arcgis.com',
    orgId: 'n6uYoouQZW75n5WI',
    servicesDirectory: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services',
    searchText: 'parcels',
    namePattern: 'statewide.?parcel',
    versionPatterns: Object.freeze(['\\bV(\\d{1,2})(?:\\.\\d+)*\\b', '\\bVersion (\\d{1,2})\\b', '^V(\\d{1,2})\\d{2}_']),
  }),
});

const PARCEL_SOURCES = Object.freeze([WISCONSIN]);

function validExtent(e) {
  return Boolean(e) && [e.west, e.south, e.east, e.north].every(Number.isFinite)
    && e.west >= -180 && e.east <= 180 && e.south >= -85 && e.north <= 85 && e.west < e.east && e.south < e.north;
}

// The exact attribute fields each source may request, besides its polygon
// geometry: an allowlist, approved per source, never a pattern. A source
// whose query asks for anything else (or is missing here) is refused at
// startup. Changing a list needs the same approval as adding a source.
//   wi-statewide-parcels: OBJECTID (row id) and OWNERNME1 (first owner name),
//     approved by Beau on 2026-11-22 for owner labels; the state confirmed on
//     2026-11-18 that the data is public domain.
const APPROVED_PARCEL_FIELDS = Object.freeze({
  'wi-statewide-parcels': Object.freeze({ idField: 'OBJECTID', ownerField: 'OWNERNME1' }),
});

// Fails loudly at startup on a config the fetcher cannot serve safely.
// approved: the field allowlist (tests pass their own for test-only sources).
function validateParcelSource(source, approved = APPROVED_PARCEL_FIELDS) {
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(source?.id || '')) problems.push('id');
  for (const key of ['region', 'name', 'release', 'credit', 'disclaimer', 'datumNote'])
    if (typeof source?.[key] !== 'string' || !source[key]) problems.push(key);
  if (source?.datum !== 'NAD83') problems.push('datum');
  let url = null;
  try { url = new URL(source?.layerUrl); } catch { /* reported below */ }
  if (!url || url.protocol !== 'https:' || url.search || url.hash || !/\/FeatureServer\/\d+$/.test(url.pathname)) problems.push('layerUrl');
  if (!validExtent(source?.extent)) problems.push('extent');
  const q = source?.query;
  // Exactly the approved fields, in order: id, then the owner name if approved.
  const allowed = Object.prototype.hasOwnProperty.call(approved, source?.id || '') ? approved[source.id] : null;
  if (!allowed) problems.push('approved fields');
  else {
    if (q?.idField !== allowed.idField) problems.push('query.idField');
    if ((q?.ownerField ?? null) !== (allowed.ownerField ?? null)) problems.push('query.ownerField');
    if (q?.outFields !== [allowed.idField, allowed.ownerField].filter(Boolean).join(',')) problems.push('query.outFields');
  }
  for (const key of ['shortName', 'vintage'])
    if (source?.[key] != null && (typeof source[key] !== 'string' || !source[key] || source[key].length > 80)) problems.push(key);
  if (source?.dataUpdated != null && !/^\d{4}-\d{2}-\d{2}$/.test(source.dataUpdated)) problems.push('dataUpdated');
  if (q?.wkid !== 3857) problems.push('query.wkid');
  if (q?.where !== '1=1' || !Number.isInteger(q?.geometryPrecision)) problems.push('query');
  const d = source?.discovery;
  if (d != null && (d.kind !== 'arcgis-org' || !Number.isInteger(d.currentVersion) || !Array.isArray(d.versionPatterns))) problems.push('discovery');
  if (problems.length) throw new Error(`invalid parcel source ${source?.id || '?'}: ${problems.join(', ')}`);
  return source;
}

function validateRegistry(sources, approved = APPROVED_PARCEL_FIELDS) {
  const ids = new Set();
  for (const source of sources) {
    validateParcelSource(source, approved);
    if (ids.has(source.id)) throw new Error(`duplicate parcel source ${source.id}`);
    ids.add(source.id);
  }
  return sources;
}

validateRegistry(PARCEL_SOURCES);

// Touching counts, as the state check always has.
function extentTouches(extent, bounds) {
  return !(bounds.east < extent.west || bounds.west > extent.east || bounds.north < extent.south || bounds.south > extent.north);
}

// The first registered source whose extent touches these lon/lat bounds, or
// null when none does.
function selectParcelSource(bounds, sources = PARCEL_SOURCES) {
  if (!validExtent(bounds)) return null;
  return sources.find(source => extentTouches(source.extent, bounds)) || null;
}

module.exports = {
  PARCEL_SOURCES,
  PARCEL_DISCLAIMER,
  WISCONSIN,
  APPROVED_PARCEL_FIELDS,
  extentTouches,
  selectParcelSource,
  validateParcelSource,
  validateRegistry,
};
