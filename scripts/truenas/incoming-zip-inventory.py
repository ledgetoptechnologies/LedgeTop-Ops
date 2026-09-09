#!/usr/bin/env python3
"""Bounded, metadata-only ZIP central-directory inventory builder.

This is intentionally not an archive extractor.  It neither opens local file
headers nor reads compressed member data.  Call it only after the caller has
scanned and identity-checked the archive it is about to describe.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from dataclasses import dataclass
from typing import BinaryIO


DEFAULT_MAX_ENTRIES = 10_000
DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_METADATA_BYTES = 1 * 1024 * 1024
DEFAULT_MAX_DEPTH = 32
EOCD = b"PK\x05\x06"
ZIP64_LOCATOR = b"PK\x06\x07"
ZIP64_EOCD = b"PK\x06\x06"
CENTRAL_DIRECTORY = b"PK\x01\x02"


class InventoryError(Exception):
    """An intentionally small, non-sensitive error vocabulary."""

    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


@dataclass(frozen=True)
class Limits:
    max_entries: int = DEFAULT_MAX_ENTRIES
    max_central_directory_bytes: int = DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES
    max_metadata_bytes: int = DEFAULT_MAX_METADATA_BYTES
    max_depth: int = DEFAULT_MAX_DEPTH


def _read_at(source: BinaryIO, offset: int, length: int) -> bytes:
    if offset < 0 or length < 0:
        raise InventoryError("malformed_central_directory")
    source.seek(offset)
    value = source.read(length)
    if len(value) != length:
        raise InventoryError("malformed_central_directory")
    return value


def _archive_size(source: BinaryIO) -> int:
    source.seek(0, os.SEEK_END)
    size = source.tell()
    if size < 22:
        raise InventoryError("not_zip")
    return size


def _directory_location(source: BinaryIO, size: int, limits: Limits) -> tuple[int, int, int]:
    # EOCD and its legal comment are at most 65,557 bytes.  This bounded tail
    # scan avoids loading the archive or its central directory into memory.
    tail_size = min(size, 22 + 0xFFFF)
    tail_offset = size - tail_size
    tail = _read_at(source, tail_offset, tail_size)
    position = tail.rfind(EOCD)
    while position >= 0:
        if position + 22 <= len(tail):
            fields = struct.unpack_from("<4s4H2IH", tail, position)
            if position + 22 + fields[7] == len(tail):
                break
        position = tail.rfind(EOCD, 0, position)
    if position < 0:
        raise InventoryError("not_zip")
    eocd_offset = tail_offset + position
    _, disk, directory_disk, entries_on_disk, entries, directory_size, directory_offset, _ = struct.unpack_from(
        "<4s4H2IH", tail, position
    )
    if disk != 0 or directory_disk != 0 or entries_on_disk != entries:
        raise InventoryError("multi_disk")

    directory_must_end_before = eocd_offset
    needs_zip64 = entries == 0xFFFF or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF
    if needs_zip64:
        if eocd_offset < 20:
            raise InventoryError("zip64_invalid")
        locator = _read_at(source, eocd_offset - 20, 20)
        signature, locator_disk, record_offset, disk_count = struct.unpack("<4sIQI", locator)
        if signature != ZIP64_LOCATOR or locator_disk != 0 or disk_count != 1:
            raise InventoryError("zip64_invalid")
        fixed = _read_at(source, record_offset, 56)
        signature, record_size, _, _, record_disk, record_directory_disk, entries_on_disk, entries, directory_size, directory_offset = struct.unpack(
            "<4sQHHIIQQQQ", fixed
        )
        if signature != ZIP64_EOCD or record_size < 44 or record_disk != 0 or record_directory_disk != 0 or entries_on_disk != entries:
            raise InventoryError("zip64_invalid")
        if record_offset + 12 + record_size != eocd_offset - 20:
            raise InventoryError("zip64_invalid")
        directory_must_end_before = record_offset

    if entries > limits.max_entries:
        raise InventoryError("entry_limit")
    if directory_size > limits.max_central_directory_bytes:
        raise InventoryError("central_directory_too_large")
    if directory_offset + directory_size > directory_must_end_before or directory_offset < 0:
        raise InventoryError("malformed_central_directory")
    return directory_offset, directory_size, entries


def _zip64_values(extra: bytes, compressed: int, uncompressed: int, local_offset: int, disk_start: int) -> tuple[int, int]:
    required = []
    if uncompressed == 0xFFFFFFFF:
        required.append("uncompressed")
    if compressed == 0xFFFFFFFF:
        required.append("compressed")
    if local_offset == 0xFFFFFFFF:
        required.append("offset")
    if disk_start == 0xFFFF:
        required.append("disk")
    if not required:
        return compressed, uncompressed
    cursor = 0
    values: bytes | None = None
    while cursor + 4 <= len(extra):
        kind, length = struct.unpack_from("<HH", extra, cursor)
        cursor += 4
        if cursor + length > len(extra):
            raise InventoryError("malformed_central_directory")
        if kind == 1:
            values = extra[cursor:cursor + length]
            break
        cursor += length
    if values is None:
        raise InventoryError("zip64_invalid")
    value_cursor = 0
    resolved: dict[str, int] = {}
    for name in required:
        length = 4 if name == "disk" else 8
        if value_cursor + length > len(values):
            raise InventoryError("zip64_invalid")
        resolved[name] = struct.unpack_from("<I" if name == "disk" else "<Q", values, value_cursor)[0]
        value_cursor += length
    if resolved.get("disk", disk_start) != 0:
        raise InventoryError("multi_disk")
    return resolved.get("compressed", compressed), resolved.get("uncompressed", uncompressed)


def _normal_path(raw: bytes, utf8: bool, is_directory: bool, limits: Limits) -> str:
    try:
        name = raw.decode("utf-8" if utf8 else "cp437")
    except UnicodeDecodeError as error:
        raise InventoryError("invalid_path") from error
    if not name or "\\" in name or "\x00" in name or any(ord(char) < 32 for char in name):
        raise InventoryError("invalid_path")
    if name.startswith("/") or (len(name) >= 2 and name[0].isalpha() and name[1] == ":"):
        raise InventoryError("invalid_path")
    if is_directory:
        if not name.endswith("/"):
            raise InventoryError("invalid_path")
        name = name[:-1]
    elif name.endswith("/"):
        raise InventoryError("invalid_path")
    pieces = name.split("/")
    if not pieces or any(part in ("", ".", "..") for part in pieces) or len(pieces) > limits.max_depth:
        raise InventoryError("invalid_path")
    return "/".join(pieces)


def inspect_archive(source: BinaryIO, limits: Limits = Limits()) -> dict[str, object]:
    """Return only bounded display metadata from a ZIP central directory."""
    if min(limits.max_entries, limits.max_central_directory_bytes, limits.max_metadata_bytes, limits.max_depth) < 1:
        raise ValueError("limits must be positive")
    try:
        size = _archive_size(source)
        directory_offset, directory_size, expected_entries = _directory_location(source, size, limits)
        source.seek(directory_offset)
        consumed = 0
        metadata_bytes = 0
        files: list[dict[str, object]] = []
        directories: set[str] = set()
        file_paths: set[str] = set()
        seen_entries: set[str] = set()
        for _ in range(expected_entries):
            if consumed + 46 > directory_size:
                raise InventoryError("malformed_central_directory")
            fixed = source.read(46)
            consumed += 46
            if len(fixed) != 46 or fixed[:4] != CENTRAL_DIRECTORY:
                raise InventoryError("malformed_central_directory")
            fields = struct.unpack("<I6H3I5H2I", fixed)
            flags, compressed, uncompressed = fields[3], fields[8], fields[9]
            name_length, extra_length, comment_length = fields[10], fields[11], fields[12]
            disk_start, external_attributes, local_offset = fields[13], fields[15], fields[16]
            variable_length = name_length + extra_length + comment_length
            if variable_length > directory_size - consumed:
                raise InventoryError("malformed_central_directory")
            raw_name = source.read(name_length)
            extra = source.read(extra_length)
            source.read(comment_length)
            consumed += variable_length
            if len(raw_name) != name_length or len(extra) != extra_length:
                raise InventoryError("malformed_central_directory")
            made_by_unix = (fields[1] >> 8) == 3
            mode = (external_attributes >> 16) & 0o170000
            if flags & 1:
                # The central directory can be read without a password, but a
                # metadata listing must not imply that encrypted contents were
                # scanned or are safe to browse.
                raise InventoryError("encrypted_entries")
            if made_by_unix and mode == 0o120000:
                raise InventoryError("unsafe_symlink")
            if made_by_unix and mode not in (0, 0o040000, 0o100000):
                raise InventoryError("unsafe_special_file")
            if disk_start != 0 and disk_start != 0xFFFF:
                raise InventoryError("multi_disk")
            is_directory = raw_name.endswith(b"/")
            path = _normal_path(raw_name, bool(flags & 0x800), is_directory, limits)
            _zip64_values(extra, compressed, uncompressed, local_offset, disk_start)
            if path in seen_entries:
                raise InventoryError("duplicate_path")
            seen_entries.add(path)
            parts = path.split("/")
            for index in range(1, len(parts)):
                parent = "/".join(parts[:index])
                if parent in file_paths:
                    raise InventoryError("conflicting_path")
                if parent not in directories:
                    if len(directories) + len(files) >= limits.max_entries:
                        raise InventoryError("entry_limit")
                    metadata_bytes += len(parent.encode("utf-8")) + len(parts[index - 1].encode("utf-8")) + 24
                    if metadata_bytes > limits.max_metadata_bytes:
                        raise InventoryError("metadata_limit")
                    directories.add(parent)
            if is_directory:
                if path in file_paths:
                    raise InventoryError("conflicting_path")
                if path not in directories:
                    if len(directories) + len(files) >= limits.max_entries:
                        raise InventoryError("entry_limit")
                    metadata_bytes += len(path.encode("utf-8")) + len(parts[-1].encode("utf-8")) + 24
                    if metadata_bytes > limits.max_metadata_bytes:
                        raise InventoryError("metadata_limit")
                    directories.add(path)
            else:
                if path in directories:
                    raise InventoryError("conflicting_path")
                if len(directories) + len(files) >= limits.max_entries:
                    raise InventoryError("entry_limit")
                file_paths.add(path)
                _, actual_uncompressed = _zip64_values(extra, compressed, uncompressed, local_offset, disk_start)
                files.append({"path": path, "name": parts[-1], "kind": "file", "size": actual_uncompressed})
                metadata_bytes += len(path.encode("utf-8")) + len(parts[-1].encode("utf-8")) + 32
                if metadata_bytes > limits.max_metadata_bytes:
                    raise InventoryError("metadata_limit")
        if consumed != directory_size:
            raise InventoryError("malformed_central_directory")
        folder_rows = [
            {"path": path, "name": path.rsplit("/", 1)[-1], "kind": "folder"}
            for path in sorted(directories)
        ]
        items = sorted(folder_rows + files, key=lambda item: (str(item["path"]), str(item["kind"])))
        result: dict[str, object] = {"status": "ready", "entries": items, "entryCount": len(items)}
        # This final check covers JSON punctuation/escaping, not just our
        # conservative per-entry accounting.
        if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > limits.max_metadata_bytes:
            raise InventoryError("metadata_limit")
        return result
    except OSError as error:
        raise InventoryError("io_error") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build bounded ZIP metadata inventory without extracting members")
    parser.add_argument("archive")
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    parser.add_argument("--max-central-directory-bytes", type=int, default=DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES)
    parser.add_argument("--max-metadata-bytes", type=int, default=DEFAULT_MAX_METADATA_BYTES)
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    args = parser.parse_args(argv)
    try:
        with open(args.archive, "rb") as source:
            result = inspect_archive(source, Limits(args.max_entries, args.max_central_directory_bytes, args.max_metadata_bytes, args.max_depth))
    except (InventoryError, ValueError, OSError) as error:
        category = error.category if isinstance(error, InventoryError) else ("io_error" if isinstance(error, OSError) else "invalid_limits")
        print(json.dumps({"status": "failed", "category": category}, separators=(",", ":")))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
