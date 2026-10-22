FROM python:3.13.14-alpine3.23@sha256:9fdbf2e3e82628351513560b121e2ee6ce31cac212be9e070c5a5e2769fb5e76
RUN apk add --no-cache clamav clamav-libunrar ca-certificates \
 && addgroup -g 10001 personnel && adduser -D -H -u 10001 -G personnel personnel \
 && mkdir -p /app /work /var/lib/clamav \
 && chown -R 10001:10001 /work /var/lib/clamav \
 && printf 'DatabaseOwner personnel\nDatabaseDirectory /var/lib/clamav\nDatabaseMirror database.clamav.net\n' > /etc/clamav/freshclam.conf
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.txt
COPY consumer.py test_consumer.py /app/
USER 10001:10001
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PERSONNEL_SCRATCH=/work
ENTRYPOINT ["python","/app/consumer.py"]
