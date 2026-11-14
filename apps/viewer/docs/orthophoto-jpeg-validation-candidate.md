# JPG validation source increment

The bounded marker reader checks the first JPEG frame/scan header and terminal
EOI, exact full-resolution dimensions, baseline 8-bit three-component structure,
and excludes private APP/COM metadata. It reads at most 1 MiB, regardless of image
size. It does not decode entropy, verify later scans or establish pixel fidelity.

The receipt validator binds source/version/operation/encoder identities and
policy to independently hashed JPG, exact P6 PPM and bounded stderr outputs.
It requires the encoder's successful reaped/cancellation-free receipt. Python
nanosecond timestamp numbers are not compared through lossy JavaScript JSON
numbers; the upcoming file adapter must independently pin/recheck BigInt stats.
Receipt validation never establishes native runtime or physical tree closure.

Five pure in-memory tests pass. This module is not installed or composed into a
service. Concrete source/script/output pinning, private evidence IO and resource
release hooks remain required before worker integration and real staging tests.
