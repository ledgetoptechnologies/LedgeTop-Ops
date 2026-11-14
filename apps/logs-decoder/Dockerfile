# Local DJI flight-log decoder for Ledge Top Logs. Runs on the designated local processing machine, not in Cloudflare.
#
# Stage 1 builds the dji-log CLI from dji-log-parser (MIT, https://github.com/lvauvillier/dji-log-parser) at the
# exact v0.5.7 commit, using the repository's own Cargo.lock (--locked). The CLI crate isn't published to crates.io.
FROM rust:1.86-slim-bookworm AS parser
ARG DJI_LOG_PARSER_REV=e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --git https://github.com/lvauvillier/dji-log-parser --rev "${DJI_LOG_PARSER_REV}" dji-log-cli --root /opt/dji-log \
 && git clone --quiet https://github.com/lvauvillier/dji-log-parser /tmp/src && git -C /tmp/src checkout --quiet "${DJI_LOG_PARSER_REV}" \
 && cp /tmp/src/LICENSE /opt/dji-log/LICENSE-dji-log-parser && rm -rf /tmp/src

# Stage 2: the runner. No npm dependencies; Node's own fetch, crypto, zlib and child_process only.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=parser /opt/dji-log/bin/dji-log /usr/local/bin/dji-log
COPY --from=parser /opt/dji-log/LICENSE-dji-log-parser /usr/share/doc/dji-log-parser/LICENSE
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production WORK_DIR=/work DJI_LOG_BIN=/usr/local/bin/dji-log
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.mjs"]
