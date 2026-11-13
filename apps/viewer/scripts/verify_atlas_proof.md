# Raw atlas proof verifier

`verify_atlas_proof.py` independently checks the converter's declared diffuse
source-to-raw-atlas crop pixels and UV affine transform. It does **not** verify
original-face geometry coverage, actual B3DM UVs, final KTX equivalence, browser
quality, Viewer readiness or cleanup eligibility.

The admitted lane is static PNG RGB/RGBA, byte channels, source edge <=8192 and
atlas edge <=16384. Normal/bump/other material maps and map options fail closed.
JPEG and APNG are not qualified by this record. A coarse mapping check can pass
with `pixelEqualityVerified=false`; it never establishes full-resolution pixel
acceptance. LOD0 requires scaleX=scaleY=1 and byte-exact decoded RGBA crop rows,
including alpha255 for an opaque RGB source.

Run with the exact corresponding per-LOD source OBJ and its original MTL/texture
closure. A source digest from the JSON sidecar does not replace that closure.
The root/tile proof tree must remain immutable under the caller's reader/writer
fence for the full check. The helper rejects symlinks, canonical path escapes,
changed file identities, inconsistent hashes/dimensions, duplicate face or
contradictory chart identities and missing atlas records. Its temporary SQLite
identity ledger is task-owned, bounded by record limits and removed afterward.

Example interface (paths supplied by the admitted caller):

```sh
/usr/bin/env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/tmp TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1 \
  OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 GDAL_NUM_THREADS=1 \
  GDAL_PAM_ENABLED=NO GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_CACHEMAX=64 \
  python3 -I -B /app/scripts/verify_atlas_proof.py \
  --source-obj /admitted-source/model.obj \
  --mapping-manifest /admitted-output/LOD-0/Mesh.texture-mapping-manifest.json \
  --lod0
```

Use a clean environment before importing GDAL; do not inherit GDAL plugin,
driver, CPL or VSI overrides. The backend passes `allowed_drivers=['PNG']`
before opening and bounds its temporary GDAL cache to16MiB, then restores the
caller's cache. Run without network, credentials or unrelated filesystem mounts.
The helper is not a sandbox: these caller/container controls remain required.

Qualification of source682847f9d268855a3aa68d3b1a51e311ed0b1159f15c02e83a286fac2a2829c1:
actual Linux main-host native image d1b3a6af.../Python3.12.3/GDAL3.8.4,
30/30 checks (23 small units +7 actual tiny PNG checks), zero failures/skips.
Cases include differing PNG encodings, crop placement, RGB/RGBA alpha,
pixel/UV/alpha tamper rejection and VRT masquerading as PNG. Receipt
96146f61d852f942ce2105009bf9bb3a426f1cb22da59ea945e6fa0436db4629;
cleaned task container/PID/cgroup and owned inputs. This is not full-size atlas,
new Viewer-image runtime or real Todd conversion acceptance.
