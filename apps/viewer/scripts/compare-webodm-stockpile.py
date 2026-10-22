"""Read-only numerical diagnostic for the pinned WebODM triangulated reference.

Optional analysis dependencies: numpy, scipy, rasterio, pyproj. Not runtime deps.
Uses bounded row strips for interpolation instead of allocating two full grids.
Formula checked against WebODM 3aaa247e1e76685bf6066b12a98c9e6e39384583
coreplugins/measure/volume.py. This is a diagnostic, not vendored server code.
"""
import hashlib
import json
import os
import pathlib
import sys

# Keep this diagnostic read-only even when a caller has GDAL PAM enabled.
os.environ['GDAL_PAM_ENABLED'] = 'NO'

import numpy as np
import rasterio
import rasterio.mask
from pyproj import Transformer
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import Delaunay

fixture_path = pathlib.Path(__file__).parent.parent / 'test/fixtures/county-road-d-webodm-reference.json'
fixture = json.loads(fixture_path.read_text())
source = pathlib.Path(sys.argv[1])
with source.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != fixture['source']['sha256']:
    raise ValueError('Source SHA256 mismatch')
with rasterio.open(source) as dataset:
    transformer = Transformer.from_crs('EPSG:4326', dataset.crs, always_xy=True)
    vertices = np.array([transformer.transform(lon, lat) for lon, lat in fixture['ringLonLat'][:-1]])
    polygon = {'type': 'Polygon', 'coordinates': [vertices.tolist() + [vertices[0].tolist()]]}
    raster, transform = rasterio.mask.mask(dataset, [polygon], crop=True, all_touched=True, indexes=1, nodata=np.nan)
    rows, cols = np.array(rasterio.transform.rowcol(transform, vertices[:, 0], vertices[:, 1]))
    heights = raster[rows, cols]
    integer_points = np.column_stack((cols, rows))
    fractional_points = np.array([(~transform) * (x, y) for x, y in vertices]) - .5
    variants = {'webodm_integer_pixel_base': integer_points, 'world_coordinate_delaunay_base': fractional_points}
    output = {'sourceSha256': digest, 'shape': list(raster.shape), 'vertexHeights': heights.tolist(), 'variants': {}}
    for name, points in variants.items():
        interpolator = LinearNDInterpolator(points, heights)
        total = 0.
        cut = 0.
        fill = 0.
        valid = 0
        for start in range(0, raster.shape[0], 256):
            stop = min(start + 256, raster.shape[0])
            x_grid, y_grid = np.meshgrid(np.arange(raster.shape[1]), np.arange(start, stop))
            base = interpolator(x_grid, y_grid)
            delta = raster[start:stop] - base
            total += np.nansum(delta)
            cut += np.nansum(np.maximum(delta, 0))
            fill += np.nansum(np.maximum(-delta, 0))
            valid += np.count_nonzero(np.isfinite(delta))
        pixel_area = abs(transform.a * transform.e)
        output['variants'][name] = {
            'netM3': total * pixel_area, 'cutM3': cut * pixel_area, 'fillM3': fill * pixel_area,
            'validCells': valid, 'webodmRoundedAbsoluteM3': abs(round(total * pixel_area, 4)),
            'differenceFromReferenceM3': abs(total * pixel_area) - fixture['expectedAbsoluteNetVolumeM3'],
            'triangles': Delaunay(points).simplices.tolist(),
        }
    print(json.dumps(output, indent=2, default=lambda value: value.item()))
