# 3D Viewer Stockpile Volume Measurement Research

**Date**: 2026-09-19
**Purpose**: Document industry-standard approaches for stockpile volume measurement in web-based 3D point cloud viewers to improve LTDS 3D viewer measurements.

---

## Industry Standard: How Major Platforms Do It

| Platform | Base Plane Methods | Data Source | Volume Algorithm |
|----------|-------------------|-------------|------------------|
| **WebODM** | Triangulated (default), Plane, Average, Lowest Point, Highest Point | DSM | 2.5D grid integration over DSM |
| **Esri SiteScan** | Lowest Point, Highest Point, Best Fit | DSM / Point Cloud | Polygon-clipped TIN vs base surface |
| **Pix4Dsurvey** | Triangulated (default), Best Fit, Lowest, Highest, Custom Z | **Point Cloud** (not DSM) | 2.5D: triangulated base surface vs point cloud |
| **DroneDeploy** | Linear Fit, Lowest Point, Triangulated | DSM | Grid-based cut/fill |
| **Propeller Aero** | Smart Volume (triangulated grid) | DSM | Triangulated grid below polygon |
| **OpenLiDARViewer** | **Area-weighted grid** (median cell surface over lowest-ground base plane) | **Point Cloud** (WebGPU) | Polygon-clipped cell areas × median elevation |
| **Stitch3D** | Best-Fit, Triangulated, Lowest Horizontal | Point Cloud | TIN vs base plane |
| **Pointerra** | Triangulated mesh, Best Fit, sampling above/below | Point Cloud | Mesh generation + base surface switching |
| **SKAND** | Triangulated, Best Fit, Lowest, Highest, Custom | DSM | Cut/Fill/Net volumes |
| **CloudCompare** | 2.5D raster grid, TIN-based | Point Cloud | Surface differencing (lidR + terra) |

---

## Key Algorithmic Patterns

### 1. Base Plane Construction (Critical Differentiator)

| Method | Description | Best For |
|--------|-------------|----------|
| **Triangulated** | Delaunay triangulation of boundary polygon vertices → interpolated surface following actual terrain | Slopes, irregular ground |
| **Best Fit Plane** | Least-squares plane through all boundary points (SVD/PCA) | Flat ground |
| **Lowest Point** | Horizontal plane at min Z of boundary | Conservative estimates |
| **Highest Point** | Horizontal plane at max Z of boundary | Fill calculations |
| **Custom Z** | User-defined horizontal plane | Target elevation workflows |

### 2. Volume Integration Methods

**Grid-based (2.5D)** — WebODM, DroneDeploy, CloudCompare, Propeller
- Rasterize point cloud to regular grid
- Σ(cell_area × height_diff)
- Fast, but loses vertical detail (overhangs, concavities)

**TIN-based** — Pix4D, SiteScan, Pointerra
- Triangulate point cloud → volume between two TIN surfaces
- Accurate for complex shapes, heavier compute

**Area-weighted Grid (OpenLiDARViewer Innovation)** — *Most relevant for browser-based viewers*
```
Algorithm (olv.volume.stockpile-area-grid@2):
1. User draws lasso polygon around stockpile toe
2. Fit "lowest-ground base plane" via point-sample estimator on boundary points
3. Overlay regular grid (cell size adaptive to point density)
4. For each grid cell:
   a. Clip cell polygon to lasso polygon (Martinez clipping)
   b. Query point cloud points within clipped cell
   c. Compute median Z (robust to noise/outliers)
   d. Cell volume = clipped_area × (median_z − base_plane_z_at_cell_center)
5. Sum all cell volumes
6. Report confidence: MEASURED (fully resident), PREVIEW (partial), WITHHELD (insufficient)
```

**Advantages**:
- Density-invariant — figure doesn't drift as more points stream in
- Median per cell rejects outliers/noise
- Works directly on point cloud (no DSM required)
- WebGPU compute shader friendly (parallel reduction per cell)

---

## OpenLiDARViewer: Reference Implementation

**Repo**: `Aurtechmx/openlidarviewer` — Browser-based, WebGPU/WebGL2, local-first

**Key Files to Study**:
- `src/volume/stockpile-area-grid.ts` — Area-weighted grid estimator
- `src/volume/stockpile-point-sample.ts` — Point-sample estimator (v1, deprecated)
- `src/perf/typed-voxel-accumulator.ts` — GPU hash map for point queries (PR #950)

**Benchmarking** (PR #956): Tested against analytic cone volume at 100k/500k/2M points — area-weighted grid converges faster and more stably than point-sample summation.

---

## What the LTDS 3D Viewer Likely Needs to Change

### Current "Dumb" Approach (Inferred)
- Single measurement tool requiring manual base definition
- No polygon-to-volume automation
- Probably DSM-only or naive point sampling

### Target Implementation (Matching WebODM/SiteScan/Pix4D/OpenLiDARViewer)

**User Workflow**:
1. Select "Stockpile Volume" tool
2. Click points around stockpile base (toe) → polygon closes on right-click/Enter
3. Base plane method selector appears (Triangulated / Best Fit / Lowest / Highest / Custom)
4. Volume calculates LIVE as points are placed
5. Display: Cut / Fill / Net volume + 2D area + surface area
6. Export: CSV/GeoJSON with polygon, base method, volumes, timestamp

**Technical Requirements**:
- Point cloud access at render time (not just DSM tiles)
- Polygon clipping library (e.g., `martinez-polygon-clipping`, `polyclip-ts`)
- Spatial index for point queries (octree, KD-tree, or grid hash)
- Base plane solvers: Delaunay (triangulated), SVD/PCA (best fit), min/max (lowest/highest)
- Grid integration: configurable cell size (default ~0.5–1m for drone data)
- Robust statistics: median per cell (not mean) to reject noise
- Streaming support: report confidence (MEASURED/PREVIEW/WITHHELD) based on point residency

---

## Recommended Open Source Code to Study/Adapt

| Repo | Language | Key Files |
|------|----------|-----------|
| `Aurtechmx/openlidarviewer` | TypeScript/WebGPU | `src/volume/stockpile-area-grid.ts`, `src/volume/stockpile-point-sample.ts` |
| `potree/potree` | JavaScript/Three.js | `src/measurements/Volume.js`, `src/utils/VolumeMeasurementTool.js` |
| `CloudCompare/CloudCompare` | C++ | `plugins/qCC/qVolume.cpp`, `plugins/qCC/qRasterize.cpp` |
| `OpenDroneMap/WebODM` | Python/JS | `webodm/views.py` (volume endpoints), `app/static/js/volume.js` |
| `yangchh17/Stockpile_Volume_Estimation` | R/Python | `R/volume_calculation.R` (lidR + terra pipeline) |

---

## Critical Implementation Detail: Point Query Performance

For browser-based viewers, **don't iterate all points per cell**. Use:

1. **Spatial Hash Grid** (uniform grid → O(1) cell lookup)
2. **Octree** (Potree-style, already in viewer if using Potree format)
3. **WebGPU Compute Shader** (OpenLiDARViewer approach — parallel reduction per cell)

OpenLiDARViewer's typed voxel accumulator (PR #950) uses open-addressing hash map on GPU — worth porting if WebGPU path exists.

---

## Immediate Next Steps for LTDS 3D Viewer

1. **Add polygon drawing tool** with snap-to-point-cloud (closest point projection)
2. **Implement 4 base plane solvers** (triangulated, best-fit, lowest, highest)
3. **Build grid integration engine**:
   - Project polygon to 2D (XY)
   - Generate regular grid covering bbox
   - Clip cells to polygon (Martinez clipping)
   - For each cell: query point cloud → median Z → volume contribution
4. **Add confidence reporting** (point density threshold per cell)
5. **Support both DSM and raw point cloud** modes (DSM for speed, point cloud for accuracy)
6. **Export GeoJSON** with measurement metadata for reporting

---

## Reference Links

- WebODM Volume Docs: https://docs.webodm.org/tutorials/measuring-stockpile-volume/
- Esri SiteScan Volume: https://support.esri.com/en-us/knowledge-base/how-to-measure-volumes-in-site-scan-for-arcgis-manager-000023029
- Pix4D Volume Algorithm: https://support.pix4d.com/hc/volume-measurement-in-pix4d-products-overview-and-algorithm-guide
- OpenLiDARViewer: https://github.com/Aurtechmx/openlidarviewer
- OpenLiDARViewer Guide: https://lidar.aurtech.mx/guide/
- Potree Measurements: https://potree.github.io/potree/examples/measurements.html
- DroneDeploy Volume: https://help.dronedeploy.com/hc/en-us/articles/1500004963922-Volume-Measurement-with-Drones
- Propeller Smart Volume: https://help.propelleraero.com/hc/en-us/articles/19384121707799-How-to-Use-Smart-Volume-Surface-Comparison
- Stitch3D Volume: https://support.stitch3d.io/articles/6628286-how-to-measure-volume
- CloudCompare Volume: https://deepwiki.com/CloudCompare/CloudCompare/4.3-rasterization-and-volume-calculation