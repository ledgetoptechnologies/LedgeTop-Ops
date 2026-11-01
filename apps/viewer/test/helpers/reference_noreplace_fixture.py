#!/usr/bin/env python3
"""Synthetic test helper only. Not a lock, authority, or production recovery."""
import ctypes
import errno
import json
import os
import re
import signal
import stat
import sys


def report(state, code):
    print(json.dumps({'state': state, 'code': code}, separators=(',', ':')))


def main():
    if sys.platform != 'linux' or len(sys.argv) != 6 or sys.argv[1] != 'isolated-noreplace-fixture':
        report('held', 'invalid_input'); return
    _, _, source, destination, device, inode = sys.argv
    if (not re.fullmatch(r'[0-9]+', device) or not re.fullmatch(r'[0-9]+', inode)
            or any(not s or s in ('.', '..') or '/' in s or '\x00' in s or len(os.fsencode(s)) > 255 for s in (source, destination))):
        report('held', 'invalid_input'); return
    moved = False
    try:
        source_parent, destination_parent = os.fstat(3), os.fstat(4)
        if not stat.S_ISDIR(source_parent.st_mode) or not stat.S_ISDIR(destination_parent.st_mode):
            report('held', 'invalid_directory'); return
        before = os.stat(source, dir_fd=3, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode) or str(before.st_dev) != device or str(before.st_ino) != inode:
            report('held', 'identity_mismatch'); return
        try:
            function = ctypes.CDLL(None, use_errno=True).renameat2
        except AttributeError:
            report('held', 'unsupported'); return
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        function.restype = ctypes.c_int
        if function(3, os.fsencode(source), 4, os.fsencode(destination), 1) != 0:
            number = ctypes.get_errno()
            # Some network filesystems can report a failed operation after the
            # server applied it. Never infer that an error means no effect.
            report('uncertain', 'destination_exists' if number == errno.EEXIST else 'os_error_' + str(number)); return
        moved = True
        if os.environ.get('VIEWER_FIXTURE_PAUSE_AFTER_RENAME') == '1':
            print('{"state":"checkpoint","code":"after_rename"}', flush=True)
            os.kill(os.getpid(), signal.SIGSTOP)
        after = os.stat(destination, dir_fd=4, follow_symlinks=False)
        if not stat.S_ISDIR(after.st_mode) or after.st_dev != before.st_dev or after.st_ino != before.st_ino:
            report('uncertain', 'identity_changed'); return
        try:
            os.stat(source, dir_fd=3, follow_symlinks=False)
            report('uncertain', 'source_reappeared'); return
        except FileNotFoundError:
            pass
        os.fsync(3); os.fsync(4)
        report('moved', 'fixture_only')
    except OSError:
        report('uncertain' if moved else 'held', 'os_error')


if __name__ == '__main__':
    main()
