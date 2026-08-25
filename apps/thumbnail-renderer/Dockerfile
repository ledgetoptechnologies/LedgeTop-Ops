FROM node:24-bookworm-slim AS common
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app /artifacts /state \
  && chown -R 568:568 /artifacts /state
WORKDIR /app
COPY --chown=568:568 package.json ./
COPY --chown=568:568 src ./src
COPY --chown=568:568 bin ./bin
ENV NODE_ENV=production LTDSTHUMB_HEALTH_STALE_MS=900000
USER 568:568
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "bin/healthcheck.mjs"]

FROM common AS broker
ENV LTDSTHUMB_ARTIFACTS_DIR=/artifacts LTDSTHUMB_STATE_DIR=/state/broker
CMD ["node", "src/broker-index.mjs"]

FROM common AS decoder
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends libvips-tools poppler-utils webp \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/jobs /work/jobs /cache \
  && chown -R 568:568 /work /cache
ENV LTDSTHUMB_JOBS_ROOT=/data/jobs \
    LTDSTHUMB_ARTIFACTS_DIR=/artifacts \
    LTDSTHUMB_WORK_DIR=/work/jobs \
    LTDSTHUMB_CACHE_DIR=/cache \
    LTDSTHUMB_STATE_DIR=/state/decoder
USER 568:568
CMD ["node", "src/index.mjs"]

FROM common AS queue-worker
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ffmpeg libvips-tools openssl poppler-utils python3 webp \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /scripts /cache /scratch \
  && chown -R 568:568 /cache /scratch
COPY --chmod=0555 truenas/thumbnail-generation/thumbnail-queue-worker.sh /scripts/thumbnail-queue-worker.sh
COPY --chmod=0555 truenas/thumbnail-generation/thumbnail-worker-supervisor.sh /scripts/thumbnail-worker-supervisor.sh
RUN sed -i 's/\r$//' /scripts/thumbnail-queue-worker.sh /scripts/thumbnail-worker-supervisor.sh
ENV LTDSTHUMB_SCRATCH_DIR=/scratch LTDSTHUMB_WORKER_CONCURRENCY=4 LTDSTHUMB_IDLE_SECONDS=5
USER 568:568
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["test", "-f", "/scratch/worker-ready"]
CMD ["/scripts/thumbnail-worker-supervisor.sh"]
