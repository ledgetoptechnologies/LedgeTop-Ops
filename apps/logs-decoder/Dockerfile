# Local DJI flight-log decoder for Ledge Top Logs. Runs on the designated local processing machine, never in Cloudflare.
#
# Stage 1 builds ltds-dji-decode (parser/), a minimal wrapper over the dji-log-parser library (MIT,
# https://github.com/lvauvillier/dji-log-parser), INSIDE the upstream workspace at the exact v0.5.7 commit. Every
# dependency therefore resolves from upstream's own Cargo.lock; the build checks that the only change to that lockfile
# is the wrapper's own package entry, so no dependency version can drift.
FROM rust:1.86-slim-bookworm AS parser
ARG DJI_LOG_PARSER_REV=e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa
# One compiler job: the build is bounded to a single CPU's worth of work (the runtime profile doesn't limit the builder).
ENV CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet https://github.com/lvauvillier/dji-log-parser /src \
 && git -C /src checkout --quiet "${DJI_LOG_PARSER_REV}" \
 && test "$(git -C /src rev-parse HEAD)" = "${DJI_LOG_PARSER_REV}"
COPY parser /src/ltds-dji-decode
WORKDIR /src
RUN cp Cargo.lock /tmp/upstream.lock \
 && sed -i 's/^members = \[/members = ["ltds-dji-decode", /' Cargo.toml \
 && cargo build --release --jobs 1 -p ltds-dji-decode \
 && ! diff /tmp/upstream.lock Cargo.lock | grep '^<' \
 && test "$(diff /tmp/upstream.lock Cargo.lock | grep '^> name = ')" = '> name = "ltds-dji-decode"' \
 && install -D -m 0555 target/release/ltds-dji-decode /opt/out/ltds-dji-decode \
 && install -D -m 0444 LICENSE /opt/out/LICENSE-dji-log-parser

# Stage 2: the runner. No npm dependencies; Node's own fetch, crypto, zlib and child_process only.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=parser /opt/out/ltds-dji-decode /usr/local/bin/ltds-dji-decode
COPY --from=parser /opt/out/LICENSE-dji-log-parser /usr/share/doc/dji-log-parser/LICENSE
WORKDIR /app
COPY package.json ./
COPY src ./src
# Proposed RAM budget (unmeasured until a real log on the admitted host): Node heap 320 MiB + tmpfs 192 MiB + parser native.
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=320 WORK_DIR=/work DJI_DECODE_BIN=/usr/local/bin/ltds-dji-decode
USER node
CMD ["node", "src/main.mjs"]
