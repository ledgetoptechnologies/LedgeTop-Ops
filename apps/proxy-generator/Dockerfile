FROM python:3.13-slim-bookworm@sha256:e32be0e55814a08977501ca863271d9bd02443710db8f2afaf8372e2c4508530 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /state /data/jobs \
    && chown 568:568 /state
WORKDIR /app
COPY --chown=568:568 proxy_generator.py /app/proxy_generator.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    JOBS_ROOT=/data/jobs STATE_DIR=/state
USER 568:568
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/app/proxy_generator.py"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["python3", "/app/proxy_generator.py", "--healthcheck"]

FROM runtime AS test
COPY --chown=568:568 tests /app/tests
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "-B", "-m", "unittest", "discover", "-s", "tests", "-v"]

FROM runtime AS production
LABEL org.opencontainers.image.source="https://github.com/ledgetoptechnologies/LedgeTop-Ops" \
    org.opencontainers.image.title="Resolve proxy generator"
