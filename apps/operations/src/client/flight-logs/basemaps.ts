// Keyless Esri basemaps, the same imagery the Viewer uses (and what OpenDroneLog offers). No Mapbox:
// it bills per map load. Esri's terms require the attribution below to stay visible on the map.
export const BASEMAPS = {
  imagery: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxNativeZoom: 19,
  },
  topo: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community",
    maxNativeZoom: 19,
  },
} as const;
export type BasemapId = keyof typeof BASEMAPS;
