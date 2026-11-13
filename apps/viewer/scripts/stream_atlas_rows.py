"""Private pinned-child RGBA8 stream; PNG-only, bounded row memory, no writes."""
import argparse
import json
import sys
from pathlib import Path
import verify_atlas_proof as atlas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--width', type=int, required=True)
    parser.add_argument('--height', type=int, required=True)
    args = parser.parse_args()
    path = Path(args.input).absolute()
    path = atlas.regular(path.parent, path.name)
    expected = atlas.digest(args.sha256)
    width, height = atlas.integer(args.width, 1, 16384), atlas.integer(args.height, 1, 16384)
    before_sha, before = atlas.hash_file(path)
    atlas.require(before_sha == expected, 'raw_stream_hash_mismatch')
    backend, raster = atlas.GdalBackend(), None
    try:
        backend.gdal.PushErrorHandler('CPLQuietErrorHandler')
        raster = backend.open(path)  # allowlisted PNG driver and Byte RGB/RGBA
        atlas.require((raster.width, raster.height) == (width, height), 'raw_stream_dimensions')
        header = {'protocol': 'ltds-rgba-rows-v1', 'schemaVersion': 1, 'width': width, 'height': height,
                  'rowBytes': width * 4, 'sha256': expected,
                  'interpretation': 'rgba8-straight-srgb-byte-values-no-transform',
                  'gdalVersion': backend.gdal.VersionInfo('RELEASE_NAME')}
        output = sys.stdout.buffer
        output.write(json.dumps(header, separators=(',', ':')).encode() + b'\n')
        for y in range(height):
            row = raster.row_rgba(0, y, width)
            atlas.require(len(row) == width * 4, 'raw_stream_row_size')
            output.write(row)
        output.flush()
        after_sha, after = atlas.hash_file(path)
        atlas.require(after_sha == expected and before == after, 'raw_stream_source_changed')
    finally:
        if raster is not None:
            raster.close()
        backend.gdal.PopErrorHandler()
        backend.close()


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # GDAL/path diagnostics stay out of the IPC/API. Parent requires exit0
        # after all rows and reaps this exact child before accepting statistics.
        sys.stderr.write('lod_texture_raw_reader_failed\n')
        sys.exit(1)
