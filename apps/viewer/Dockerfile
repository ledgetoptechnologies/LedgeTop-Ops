# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: fetch a pinned Potree build.
# public/potree/ is intentionally gitignored (large third-party viewer lib
# not owned by this repo) so it has to be fetched at image build time.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS potree
ARG POTREE_VERSION=1.8.2
ARG POTREE_SHA256=c140a8bce0ce129de762fbc0fd3ba7c21120ffd36d423dd2755abb39f32aebe5
WORKDIR /tmp
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Copy the release root, not just its build/ directory. pointcloud.html loads
# both /potree/build/potree/* and /potree/libs/* at runtime.
RUN curl -fsSL -o potree.zip \
      "https://github.com/potree/potree/releases/download/${POTREE_VERSION}/Potree_${POTREE_VERSION}.zip" \
    && echo "${POTREE_SHA256}  potree.zip" | sha256sum -c - \
    && mkdir -p extracted && unzip -q potree.zip -d extracted \
    && POTREE_BUILD_DIR="$(find extracted -type d -path '*/build/potree' | head -n1)" \
    && test -n "$POTREE_BUILD_DIR" \
    && SRC_DIR="$(dirname "$(dirname "$POTREE_BUILD_DIR")")" \
    && mkdir -p /potree \
    && cp -r "$SRC_DIR"/. /potree/ \
    && test -s /potree/build/potree/potree.js \
    && test -s /potree/libs/jquery/jquery-3.1.1.min.js \
    && test -s /potree/libs/three.js/build/three.min.js \
    && test -s /potree/libs/copc/index.js \
    && test -s /potree/libs/plasio/js/laslaz.js

# Pinned LTDS Obj2Tiles fork. The official OpenDroneMap v1.6.2 source archive
# and the reviewable local patch are both hash-verified before a self-contained
# binary is built. No SDK or build-time network dependency enters runtime.
FROM mcr.microsoft.com/dotnet/sdk:10.0.203-noble@sha256:8a90a473da5205a16979de99d2fc20975e922c68304f5c79d564e666dc3982fc AS obj2tiles
ARG TARGETARCH
ARG OBJ2TILES_VERSION=1.6.2
ARG OBJ2TILES_SOURCE_SHA256=79093e12f6eab2cfcd522aebe670892c5d8874e160956b84f3e55c77b94ac0b5
ARG OBJ2TILES_PATCH_SHA256=6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY third_party/obj2tiles/v1.6.2-bounded-concurrency.patch /tmp/obj2tiles.patch
COPY third_party/obj2tiles/locks /tmp/obj2tiles-locks
RUN curl -fsSL -o /tmp/obj2tiles.tar.gz \
      "https://codeload.github.com/OpenDroneMap/Obj2Tiles/tar.gz/refs/tags/v${OBJ2TILES_VERSION}" \
    && echo "${OBJ2TILES_SOURCE_SHA256}  /tmp/obj2tiles.tar.gz" | sha256sum -c - \
    && echo "${OBJ2TILES_PATCH_SHA256}  /tmp/obj2tiles.patch" | sha256sum -c - \
    && mkdir -p /src/obj2tiles \
    && tar -xzf /tmp/obj2tiles.tar.gz --strip-components=1 -C /src/obj2tiles \
    && cd /src/obj2tiles \
    && git apply --check /tmp/obj2tiles.patch \
    && git apply /tmp/obj2tiles.patch \
    && case "$TARGETARCH" in \
      amd64) rid=linux-x64 ;; \
      arm64) rid=linux-arm64 ;; \
      *) echo "unsupported Obj2Tiles architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && for project in MeshDecimatorCore Obj2Tiles.Library Obj2Gltf Obj2Tiles; do \
      cp "/tmp/obj2tiles-locks/$rid/$project/packages.lock.json" "$project/packages.lock.json"; \
    done \
    && dotnet restore Obj2Tiles/Obj2Tiles.csproj --locked-mode -r "$rid" \
    && dotnet publish Obj2Tiles/Obj2Tiles.csproj -c Release -r "$rid" --self-contained true --no-restore \
      -p:PublishSingleFile=true -p:PublishTrimmed=false -p:DebuggerSupport=false -o /opt/obj2tiles \
    && test -x /opt/obj2tiles/Obj2Tiles \
    && /opt/obj2tiles/Obj2Tiles --version 2>&1 | grep -F "${OBJ2TILES_VERSION}" \
    && cp LICENSE.md /opt/obj2tiles/LICENSE.md \
    && binary_sha256="$(sha256sum /opt/obj2tiles/Obj2Tiles | cut -d ' ' -f1)" \
    && printf '{"schemaVersion":1,"sourceVersion":"v%s","sourceSha256":"%s","patchSha256":"%s","binarySha256":"%s"}\n' \
      "$OBJ2TILES_VERSION" "$OBJ2TILES_SOURCE_SHA256" "$OBJ2TILES_PATCH_SHA256" "$binary_sha256" \
      > /opt/obj2tiles/build-info.json \
    && test "$(sha256sum /opt/obj2tiles/Obj2Tiles | cut -d ' ' -f1)" = "$binary_sha256"

# The same small, pinned screened-Poisson executable is source-built on amd64
# and arm64. It is a worker-only computation tool, not another service. Keep
# IEEE arithmetic (no -ffast-math), double precision, and a fixed thread budget.
FROM debian:bookworm-slim AS poisson
ARG POISSON_SOURCE_COMMIT=262b0f539d404057d1f36e1adc07fc9388678899
ARG POISSON_SOURCE_SHA256=4a07ad091a63cc8403c57a8906b97b41d07c2fd87aa8aad0e7680dac20c4dcd5
ARG POISSON_PATCH_SHA256=9ecff362ba0dba772d1969b415768ecc5503aba3f2dc5e18d2d101834ba9272c
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl g++ patch libpng-dev libjpeg62-turbo-dev libturbojpeg0-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
COPY third_party/poissonrecon/262b0f5-two-threads.patch /tmp/poisson.patch
RUN curl -fsSL "https://codeload.github.com/mkazhdan/PoissonRecon/tar.gz/${POISSON_SOURCE_COMMIT}" -o /tmp/source.tar.gz \
    && echo "${POISSON_SOURCE_SHA256}  /tmp/source.tar.gz" | sha256sum -c - \
    && echo "${POISSON_PATCH_SHA256}  /tmp/poisson.patch" | sha256sum -c - \
    && mkdir -p /src/poisson /opt/poisson \
    && tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src/poisson \
    && cd /src/poisson && patch --batch -p1 < /tmp/poisson.patch \
    && g++ -O2 -DNDEBUG -DFAST_COMPILE -DUSE_DOUBLE -std=c++17 -fopenmp -pthread -I. Src/PoissonRecon.cpp -o /opt/poisson/PoissonRecon -lpng -ljpeg -lturbojpeg -lz \
    && strip /opt/poisson/PoissonRecon \
    && /opt/poisson/PoissonRecon 2>&1 | grep -F 'Usage:' \
    && cp LICENSE /opt/poisson/LICENSE \
    && printf '{"sourceCommit":"%s","sourceSha256":"%s","patchSha256":"%s","threads":2,"precision":"double"}\n' "$POISSON_SOURCE_COMMIT" "$POISSON_SOURCE_SHA256" "$POISSON_PATCH_SHA256" > /opt/poisson/build-info.json

# ---------------------------------------------------------------------------
# Stage 2: build the Vite frontend (bundles main.js, copies public/ incl.
# the fetched Potree build into dist/).
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-3d-tiles-renderer.mjs scripts/install-basis-transcoder.mjs ./scripts/
COPY scripts/lib ./scripts/lib
RUN npm ci
COPY . .
COPY --from=potree /potree ./public/potree
RUN node scripts/patch-potree-ept.mjs public/potree/build/potree/potree.js
RUN node scripts/build-potree-ept-worker.mjs
RUN npx vite build

# ---------------------------------------------------------------------------
# Stage 3: runtime — Node/Express server serves dist/ + the viewer API and
# proxies read-only WebODM assets. No build tools, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ARG VIEWER_SOURCE_COMMIT=unknown
ENV NODE_ENV=production
ENV OBJ2TILES_BIN=/opt/obj2tiles/Obj2Tiles
ENV MEASUREMENT_POISSON_BIN=/opt/poisson/PoissonRecon
LABEL org.opencontainers.image.revision="${VIEWER_SOURCE_COMMIT}"
WORKDIR /app
RUN groupmod --gid 568 node \
    && usermod --uid 568 --gid 568 node
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libpng16-16 libjpeg62-turbo libturbojpeg0 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts/patch-3d-tiles-renderer.mjs scripts/install-basis-transcoder.mjs ./scripts/
COPY scripts/lib ./scripts/lib
RUN npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
COPY lod-policy.mjs lod-memory-profile.mjs ./
COPY measurement-volume.mjs raster-source-metadata.mjs raster-tiff-header.mjs raster-vertical-units.mjs ./
COPY lod-converter-policy.cjs ./lod-converter-policy.cjs
COPY --from=obj2tiles /opt/obj2tiles /opt/obj2tiles
COPY --from=poisson /opt/poisson /opt/poisson
COPY --from=build /app/dist ./dist
RUN printf '%s\n' "${VIEWER_SOURCE_COMMIT}" > /app/source-commit.txt \
    && chmod 0444 /app/source-commit.txt \
    && mkdir -p /app/storage/data /app/storage/datasets /app/storage/models \
      /app/storage/cache /app/storage/trash \
      /app/storage/imports/datasets /app/storage/imports/terra \
    && chown -R 568:568 /app/storage

EXPOSE 8088
USER 568:568
CMD ["node", "server/index.js"]
