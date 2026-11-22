"""Linux syscalls the standard library does not expose: statx (birth time, mount id) and renameat2.

Every call is relative to an already-open directory descriptor and never follows a final symlink.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import errno
import hashlib
import os
import struct
from dataclasses import dataclass

from ..errors import Denied

AT_SYMLINK_NOFOLLOW = 0x100
AT_EMPTY_PATH = 0x1000
STATX_BASIC_STATS = 0x7FF
STATX_BTIME = 0x800
STATX_MNT_ID = 0x1000
RENAME_NOREPLACE = 1
_STATX_SIZE = 256

_libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
_statx = getattr(_libc, "statx", None)
_renameat2 = getattr(_libc, "renameat2", None)
if _statx is not None:
    _statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    _statx.restype = ctypes.c_int
if _renameat2 is not None:
    _renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    _renameat2.restype = ctypes.c_int


@dataclass(frozen=True)
class Stat:
    mode: int
    nlink: int
    uid: int
    ino: int
    size: int
    dev: tuple[int, int]
    mount_id: int
    birth: tuple[int, int]
    mtime_ns: int
    ctime_ns: int

    @property
    def object_id(self) -> str:
        """Opaque, stable identity: device, inode and birth time (inode reuse changes the birth time)."""
        raw = f"ltfiles-object-v1\n{self.dev[0]}:{self.dev[1]}\n{self.ino}\n{self.birth[0]}.{self.birth[1]:09d}"
        return hashlib.sha256(raw.encode("ascii")).hexdigest()[:32]


def statx(dir_fd: int, name: str | None = None) -> Stat:
    """statx of `name` under `dir_fd` (or of `dir_fd` itself), never following a final symlink.

    Refuses filesystems that cannot report birth time and mount id: object identity depends on both.
    """
    if _statx is None:
        raise Denied("filesystem-unsupported", 503)
    buffer = ctypes.create_string_buffer(_STATX_SIZE)
    path = b"" if name is None else os.fsencode(name)
    flags = AT_SYMLINK_NOFOLLOW | (AT_EMPTY_PATH if name is None else 0)
    if _statx(dir_fd, path, flags, STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID, buffer) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    raw = buffer.raw
    mask, = struct.unpack_from("<I", raw, 0)
    if mask & STATX_BTIME == 0 or mask & STATX_MNT_ID == 0:
        raise Denied("filesystem-unsupported", 503)
    nlink, uid = struct.unpack_from("<II", raw, 16)
    mode, = struct.unpack_from("<H", raw, 28)
    ino, size = struct.unpack_from("<QQ", raw, 32)
    btime = struct.unpack_from("<qI", raw, 80)
    ctime = struct.unpack_from("<qI", raw, 96)
    mtime = struct.unpack_from("<qI", raw, 112)
    dev = struct.unpack_from("<II", raw, 136)
    mount_id, = struct.unpack_from("<Q", raw, 144)
    return Stat(mode, nlink, uid, ino, size, dev, mount_id, btime,
                mtime[0] * 1_000_000_000 + mtime[1], ctime[0] * 1_000_000_000 + ctime[1])


def rename_noreplace(src_dir: int, src_name: str, dst_dir: int, dst_name: str) -> None:
    """Atomic rename that fails with FileExistsError instead of replacing anything."""
    if _renameat2 is None:
        raise Denied("filesystem-unsupported", 503)
    if _renameat2(src_dir, os.fsencode(src_name), dst_dir, os.fsencode(dst_name), RENAME_NOREPLACE) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, os.strerror(code))
        if code in (errno.EINVAL, errno.ENOSYS):
            raise Denied("filesystem-unsupported", 503)
        raise OSError(code, os.strerror(code))


def fsync_dir(fd: int) -> None:
    os.fsync(fd)
