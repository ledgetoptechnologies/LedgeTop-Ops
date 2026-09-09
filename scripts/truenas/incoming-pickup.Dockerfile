FROM alpine:3.20

# Keep the server-owned scanner/toolchain pinned in the released image. Runtime
# containers are read-only, so package installation must never happen on an
# hourly pickup invocation.
RUN apk add --no-cache bash aws-cli clamav clamav-libunrar curl python3 coreutils util-linux \
  && mkdir -p /usr/local/libexec /var/lib/clamav \
  && chmod 0755 /usr/local/libexec /var/lib/clamav

COPY scripts/truenas/incoming-pickup-worker.sh /usr/local/libexec/incoming-pickup-worker.sh
COPY scripts/truenas/incoming-pickup-entrypoint.sh /usr/local/libexec/incoming-pickup-entrypoint.sh
COPY scripts/truenas/incoming-zip-inventory.py scripts/truenas/incoming-zip-receipts.py /usr/local/libexec/
RUN chmod 0755 /usr/local/libexec/incoming-pickup-worker.sh /usr/local/libexec/incoming-pickup-entrypoint.sh

ENTRYPOINT ["/usr/local/libexec/incoming-pickup-entrypoint.sh"]
CMD ["--once"]
