FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libvips-tools \
    poppler-utils \
    webp \
    ffmpeg \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home --home-dir /home/renderer renderer \
  && install -d -o renderer -g renderer -m 0700 /tmp/ltds-renderer

WORKDIR /app
COPY --chown=root:root render-thumbnail.mjs /app/render-thumbnail.mjs
RUN chmod 0555 /app/render-thumbnail.mjs

USER 10001:10001
ENV HOME=/home/renderer \
    TMPDIR=/tmp/ltds-renderer \
    VIPS_CONCURRENCY=2 \
    MALLOC_ARENA_MAX=2

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sleep", "infinity"]
