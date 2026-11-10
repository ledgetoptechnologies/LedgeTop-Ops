#!/usr/bin/env python3
"""Review-only staging capacity monitor; not a quota or reservation."""
import argparse
import json
import os
import re
import subprocess
import sys
import time

ROOT = "/var/lib/ledgetop-viewer-photo-staging/db"
SHARE = "/mnt/ViewerStaging"
SHARE_SOURCE = "//192.168.50.80/Ai_Storage/Shared/Staging/viewer"


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=True,
                            timeout=5, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    return result.stdout


def mount(path, expected_target, expected_type, expected_source=None, expected_device=None):
    payload = json.loads(run('/usr/bin/findmnt', '--json', '--target', path,
                             '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN'))
    items = payload['filesystems']
    # A systemd automount may appear alongside the real CIFS mount. Accept
    # precisely that pair; additional stacked or unexpected mounts fail.
    if expected_type == 'cifs' and len(items) == 2:
        automounts = [item for item in items if item.get('target') == expected_target
                      and item.get('fstype') == 'autofs' and item.get('source') == 'systemd-1']
        filesystems = [item for item in items if item.get('fstype') == 'cifs']
        if len(automounts) != 1 or len(filesystems) != 1:
            raise ValueError('unexpected automount stack')
        item = filesystems[0]
    elif len(items) == 1:
        item = items[0]
    else:
        raise ValueError('mount lookup was ambiguous')
    if (item['target'] != expected_target or item['fstype'] != expected_type
            or 'rw' not in item['options'].split(',')
            or (expected_source is not None and item['source'] != expected_source)
            or (expected_device is not None and item['maj:min'] != expected_device)):
        raise ValueError('mount identity or access changed')


def available(path):
    output = run('/usr/bin/df', '-B1', '--output=avail,iavail', '--', path).splitlines()
    if len(output) != 2:
        raise ValueError('unexpected capacity response')
    fields = output[1].split()
    if len(fields) != 2 or any(not field.isdecimal() for field in fields):
        raise ValueError('capacity or inode count unavailable')
    return tuple(map(int, fields))


def check_capacity(root_minimum, share_minimum, inode_minimum, root_device):
    mount(ROOT, '/', 'ext4', expected_device=root_device)
    mount(SHARE, SHARE, 'cifs', SHARE_SOURCE)
    root_bytes, root_inodes = available(ROOT)
    share_bytes, _share_inodes_unknown = available(SHARE)
    # This CIFS server reports IFree=0 even when files can be created. Do not
    # interpret that field as available inode capacity or invent a value.
    if (root_bytes < root_minimum or share_bytes < share_minimum
            or root_inodes < inode_minimum):
        raise ValueError('staging capacity below threshold')


def notify(*args):
    socket = os.environ.get('NOTIFY_SOCKET')
    if not socket:
        raise ValueError('systemd notification socket unavailable')
    subprocess.run(('/usr/bin/systemd-notify', *args), capture_output=True,
                   text=True, check=True, timeout=5,
                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C',
                        'NOTIFY_SOCKET': socket})


def main():
    parser = argparse.ArgumentParser()
    for option in ('root-admit', 'root-stop', 'share-admit', 'share-stop', 'min-inodes'):
        parser.add_argument('--' + option, type=int, required=True)
    parser.add_argument('--root-device', required=True)
    args = parser.parse_args()
    if min(args.root_admit, args.root_stop, args.share_admit, args.share_stop, args.min_inodes) <= 0:
        raise ValueError('thresholds must be positive')
    if args.root_admit <= args.root_stop or args.share_admit <= args.share_stop:
        raise ValueError('admission thresholds must exceed stop thresholds')
    if not re.fullmatch(r'[0-9]+:[0-9]+', args.root_device):
        raise ValueError('invalid root device pin')
    check_capacity(args.root_admit, args.share_admit, args.min_inodes, args.root_device)
    notify('--ready')
    while True:
        check_capacity(args.root_stop, args.share_stop, args.min_inodes, args.root_device)
        notify('WATCHDOG=1')
        time.sleep(5)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print('staging capacity monitor failed:', type(error).__name__, file=sys.stderr)
        sys.exit(1)
