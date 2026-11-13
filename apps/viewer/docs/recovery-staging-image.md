# Controlled recovery image candidate

This source composition combines PR547 at `1c88450b` with the Processing owner's
frozen 33-file overlay. It is preparation, not an installed image, successful
full-size conversion or release. PR558 is independent and is not included.

`Dockerfile.recovery-staging` preserves the owner's admitted cached runtime,
dependencies, frontend and license notices. It checks matching package files,
adds the GDAL/Python proof dependency and records actual package versions. It
copies the exact qualified x86-64 publication, verifies its two runtime hashes
and current converter policy, and stamps the actual composition commit. The
build-info JSON describes the supplied publication; it is not an independent
proof receipt. No private license, source reconstruction or converter recompile
is involved. Existing normal Docker/publisher files remain separately reviewed
owner inputs; this recipe has no Actions trigger.

Before an owner-admitted build, inspect the actual base's manifest/config identity,
architecture, Node ABI, dependency lock and existing license notices. A reported
Docker config ID is not a registry manifest digest. Supply BASE_IMAGE as the
verified immutable reference, TARGETARCH=amd64 and VIEWER_SOURCE_COMMIT as this
composition's real 40-character commit. The named qualified-publication context
must contain only verified publication files from the sanitized archive; verify
the archive and each member against the owner's manifest before building. Do not
use a remote image as that context or send a secret-bearing parent directory.

Installed-base package compatibility and actual GDAL dependency installation are
not yet qualified. Record image bytes, build output, package versions and smoke
checks; do not claim source tests prove these. No build or startup is performed
by this document. Full-resolution converter memory/output acceptance remains
open after the 8 and 16 GiB failures; keep resolution and quality unchanged.

The controller module is not an HTTP route or daemon. Actual fixed-operator,
fixed-attempt host wiring still requires authoritative producer/incarnation,
proof and application writer-admission adapters. Before a real run, qualify
source/current receipt/renderer acceptance and functional startup/rollback.
Only the host owner may admit the staging writer exclusion and controlled intake
to RO verification handoff. Preserve all retained data, the journal and holds;
never downgrade the database or resume unaware writers over a nonterminal hold.
