#!/usr/bin/python3
"""Validate a user-confirmed projected EPSG against every Emlid geographic check.
No source values are written to stdout or the filesystem.
"""
import sys, json, math
from osgeo import osr

def fail():
    print('{"ok":false}')
    sys.exit(1)
try:
    value = json.load(sys.stdin)
    code, unit, points = value['epsgCode'], value['horizontalUnit'], value['points']
    if not isinstance(code, int) or isinstance(code, bool) or not 1000 <= code <= 999999 or unit not in ('m', 'ftUS') or not 1 <= len(points) <= 5000: fail()
    source = osr.SpatialReference()
    if source.ImportFromEPSG(code) != 0 or not source.IsProjected(): fail()
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    expected = 1.0 if unit == 'm' else 1200.0 / 3937.0
    if abs(source.GetLinearUnits() - expected) > 1e-10: fail()
    target = osr.SpatialReference(); target.ImportFromEPSG(4326); target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source, target)
    maximum = 0.0
    for point in points:
        x, y = point['easting'] / expected, point['northing'] / expected
        longitude, latitude, _ = transform.TransformPoint(x, y, 0)
        lat, lon = point['latitude'], point['longitude']
        if not all(math.isfinite(v) for v in (latitude, longitude, lat, lon)): fail()
        lat1,lat2 = math.radians(latitude),math.radians(lat)
        dlat,dlon = lat2-lat1,math.radians(lon-longitude)
        a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
        distance=12742017.6*math.asin(min(1,math.sqrt(max(0,a))))
        maximum=max(maximum,distance)
    if maximum > 5: fail()
    print('{"ok":true}')
except Exception:
    fail()
