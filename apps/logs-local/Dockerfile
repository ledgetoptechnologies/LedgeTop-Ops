# Ledge Top flight logs, fully local (NAS). Build context: the repository root.
#   docker build -f apps/logs-local/Dockerfile --target keyless .   # Node only: uploads, history, Ops API; decoder waits
#   docker build -f apps/logs-local/Dockerfile --target full .      # adds the native DJI parser (decoding once a key is set)
# Nothing here is built or run until Merger admits the exact artifact, profile and window.
#
# Runtime: Node 24 only, no npm packages (node:sqlite, node:http, WebCrypto). The app refuses a WAL database on a
# SQLite build without the WAL-reset fix (walSafeSqlite), so a bad base image fails closed at start.

# Base images. NODE_IMAGE is pinned to the digest Merger read back from the qualified Stage host (Node 24.19.0,
# SQLite 3.53), so an admitted build uses the cached base without pulling a moving tag. The Rust image is only used
# by the full target; its digest is pinned at that target's admission (no digest is invented here).
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG RUST_IMAGE=rust:1.86-slim-bookworm

# --- Native parser (full target only): the reviewed #584 build, unchanged ---------------------------------------------
FROM ${RUST_IMAGE} AS parser
ARG DJI_LOG_PARSER_REV=e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa
ENV CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet https://github.com/lvauvillier/dji-log-parser /src \
 && git -C /src checkout --quiet "${DJI_LOG_PARSER_REV}" \
 && test "$(git -C /src rev-parse HEAD)" = "${DJI_LOG_PARSER_REV}"
COPY apps/logs-decoder/parser /src/ltds-dji-decode
WORKDIR /src
RUN cp Cargo.lock /tmp/upstream.lock \
 && sed -i 's/^members = \[/members = ["ltds-dji-decode", /' Cargo.toml \
 && cargo build --release --jobs 1 -p ltds-dji-decode \
 && ! diff /tmp/upstream.lock Cargo.lock | grep '^<' \
 && test "$(diff /tmp/upstream.lock Cargo.lock | grep '^> name = ')" = '> name = "ltds-dji-decode"' \
 && install -D -m 0555 target/release/ltds-dji-decode /opt/out/ltds-dji-decode \
 && install -D -m 0444 LICENSE /opt/out/LICENSE-dji-log-parser

# --- Keyless runtime: everything except the native parser --------------------------------------------------------------
FROM ${NODE_IMAGE} AS keyless
WORKDIR /app
# Only the runtime sources: the Logs worker code and migrations, the decoder runner, and the local host.
COPY apps/logs/src/worker apps/logs/src/worker
COPY apps/logs/src/odl/map.mjs apps/logs/src/odl/util.mjs apps/logs/src/odl/contract.mjs apps/logs/src/odl/
COPY apps/logs/migrations apps/logs/migrations
COPY apps/logs-decoder/src apps/logs-decoder/src
COPY apps/logs-local/package.json apps/logs-local/package.json
COPY apps/logs-local/src apps/logs-local/src
COPY apps/logs-local/migrations apps/logs-local/migrations
# Heap bounded for the 1 GiB container; the decoder's scratch is a separate RAM tmpfs (/work).
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=320
USER 568:568
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/logs-local/src/bootstrap.mjs"]

# --- Full runtime: keyless plus the reviewed native parser ------------------------------------------------------------
FROM keyless AS full
COPY --from=parser /opt/out/ltds-dji-decode /usr/local/bin/ltds-dji-decode
COPY --from=parser /opt/out/LICENSE-dji-log-parser /usr/share/doc/dji-log-parser/LICENSE
