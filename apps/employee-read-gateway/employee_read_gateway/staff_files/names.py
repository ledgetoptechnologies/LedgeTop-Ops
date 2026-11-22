"""Name rules for writes: names every Windows client can hold, and case-insensitive sibling identity."""
from __future__ import annotations

import re
import unicodedata

from ..core import path_parts
from ..errors import Denied

_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(?:\..*)?\Z", re.IGNORECASE)
_FORBIDDEN = set('<>:"/\\|?*')


def fold(name: str) -> str:
    """The key Windows treats as the same name: NFC-normalized and case-folded."""
    return unicodedata.normalize("NFC", name).casefold()


def writable_name(name: str) -> str:
    """A single path component a Windows client can create, open and round-trip."""
    if not isinstance(name, str) or not name or name in (".", "..") or len(name.encode("utf-8")) > 255:
        raise Denied("invalid-name")
    if name != unicodedata.normalize("NFC", name):
        raise Denied("invalid-name")
    if any(c in _FORBIDDEN or unicodedata.category(c) in ("Cc", "Cf", "Cs", "Co", "Cn") for c in name):
        raise Denied("invalid-name")
    if name[-1] in ". " or name[0] == " " or _RESERVED.match(name):
        raise Denied("invalid-name")
    return name


def target_parts(path: str) -> list[str]:
    """A canonical relative path whose final component is a writable name (parents only need to exist)."""
    parts = path_parts(path)
    writable_name(parts[-1])
    return parts
