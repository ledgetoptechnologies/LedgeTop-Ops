#!/usr/bin/env python3
"""Review-only worker preflight; checks live API/proxy without printing env."""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys

VIEWER_IMAGE = 'sha256:5b78e6122467968e617932a4d4a19388db7dac576449acb4bf1c790f723170c5'
PROXY_IMAGE = 'sha256:697b0b156c70b91130853fd0675c6be36665939d5f93dce2686be04b4c3f98a8'
COMPOSE_HASHES = {
    '/home/bkoltz/3d-viewer-staging/compose.yaml': '40fc78e5e28fcc961401017ec605f6d15679b9b7a9f51741623387c4524918d8',
    '/home/bkoltz/3d-viewer-staging/compose.viewer-ui-acceptance-20261023.yaml': 'c1cfd44b00e5a48117cb5fa26f680cd0cb0b1c7a94b619804866623a216737c8',
    '/home/bkoltz/3d-viewer-staging/compose.processing-candidate.yaml': '0a27e3cddc187c3a6cf8ae63394dcaa67944e617eaf44caaa682c95086f1622b',
}
NETWORKS = {
    'viewer-staging_viewer-edge': '881ff31db1f8a9b10bb42f0c9ef8591f684f58f9227e647e3fad32c76d03ee6b',
    'viewer-staging_viewer-private': '06a0bec77b53b512a52c20232c3ea3c7c580822a7b67f32f72bf455fef26b85d',
}
API_MOUNTS = {
    '/app/storage': ('/mnt/ViewerStaging', True),
    '/app/storage/data': ('/var/lib/ledgetop-viewer-photo-staging/db', True),
    '/run/processing-trust/ca.crt': ('/var/lib/ledgetop-viewer-photo-staging/coordinator-ca.crt', False),
    '/app/staging-storage-guard.cjs': ('/home/bkoltz/3d-viewer-staging/config/staging-storage-guard.cjs', False),
    '/app/AGENTS.md': ('/home/bkoltz/3d-viewer-staging/AGENTS.md', False),
}
PROXY_MOUNTS = {
    '/etc/nginx/conf.d/default.conf': ('/home/bkoltz/3d-viewer-staging/config/nginx.conf', False),
    '/etc/nginx/staging/tls.crt': ('/home/bkoltz/3d-viewer-staging/config/tls.crt', False),
    '/etc/nginx/staging/tls.key': ('/home/bkoltz/3d-viewer-staging/config/tls.key', False),
}
API_ENV = {'DATABASE_PATH': '/app/storage/data/viewer.sqlite',
           'DATA_DIR': '/app/storage/data', 'DATASETS_MOUNT': '/app/storage/datasets',
           'MODELS_MOUNT': '/app/storage/models', 'CACHE_MOUNT': '/app/storage/cache',
           'TRASH_MOUNT': '/app/storage/trash', 'TERRA_IMPORT_MOUNT': '/app/storage/imports/terra',
           'DATASET_IMPORT_MOUNT': '/app/storage/imports/datasets', 'WEBODM_MEDIA_MOUNT': '',
           'NODE_EXTRA_CA_CERTS': '/run/processing-trust/ca.crt',
           'PROCESSING_PLATFORM_ENABLED': 'true', 'PROCESSING_WORKER_ENABLED': 'false',
           'LOCAL_DERIVATIVES_ENABLED': 'false', 'MESH_DERIVATIVES_ENABLED': 'true',
           'CLIENT_VIEWER_SHARES_ENABLED': 'false',
           'VIEWER_REFERENCE_ACCEPTANCE_ENABLED': 'false',
           'VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED': 'false', 'VIEWER_SOURCE_RELEASE_ENABLED': 'false'}
COMMANDS = {
    'worker': ('/bin/sh', ['-ec', 'node /app/staging-storage-guard.cjs && exec docker-entrypoint.sh node server/workerSupervisor.js']),
    'api': ('/bin/sh', ['-ec', 'node /app/staging-storage-guard.cjs && exec docker-entrypoint.sh node server/index.js']),
    'proxy': ('/docker-entrypoint.sh', ['nginx', '-g', 'daemon off;']),
}
FORBIDDEN_ENV = {'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_USE_SYSTEM_CA',
                 'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
                 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def inspect(name):
    result = subprocess.run(('/usr/bin/docker', 'inspect', name), capture_output=True, text=True,
                            check=True, timeout=10, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    values = json.loads(result.stdout)
    check(isinstance(values, list) and len(values) == 1, 'container inspection failed')
    return values[0]


def verify_compose_files():
    for path, expected in COMPOSE_HASHES.items():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            check(stat.S_ISREG(info.st_mode) and info.st_size <= 1048576, 'invalid Compose file')
            check(hashlib.sha256(stream.read()).hexdigest() == expected, 'Compose file changed')


def validate(container, service, image, *, created=False):
    config = container['Config']
    labels = config.get('Labels') or {}
    check(container['Name'] == '/viewer-staging-viewer-' + service + '-1', 'container name changed')
    state_ok = (container['State']['Status'] in ('created', 'exited') and container['State']['Running'] is False) if created else (container['State']['Running'] is True and container['State'].get('Health', {}).get('Status') == 'healthy')
    check(state_ok and container['Image'] == image, 'container image or health changed')
    check((container['Path'], container['Args']) == COMMANDS[service]
          and container['HostConfig']['ReadonlyRootfs'] is True, 'container command or root filesystem changed')
    check(labels.get('com.docker.compose.project') == 'viewer-staging' and
          labels.get('com.docker.compose.service') == 'viewer-' + service, 'container project identity changed')
    networks = container['NetworkSettings']['Networks']
    check(set(networks) == set(NETWORKS) and (created or all(networks[k]['NetworkID'] == v for k, v in NETWORKS.items())),
          'container networks changed')
    if not created:
        check(networks['viewer-staging_viewer-edge']['IPAddress'] == {'api': '172.23.0.3', 'proxy': '172.23.0.2', 'worker': '172.23.0.4'}[service], 'container edge IP changed')
    seen = set()
    for item in config.get('Env') or []:
        key, sep, _ = item.partition('=')
        check(bool(sep) and key not in seen and key not in FORBIDDEN_ENV, 'unsafe or duplicate container environment')
        seen.add(key)
    mounts = container['Mounts']
    expected_mounts = API_MOUNTS if service in ('api', 'worker') else PROXY_MOUNTS
    check(len(mounts) == len(expected_mounts) and {m['Destination'] for m in mounts} == set(expected_mounts),
          'unexpected container mount')
    for destination, (source, writable) in expected_mounts.items():
        found = [m for m in mounts if m['Destination'] == destination]
        check(len(found) == 1 and found[0]['Type'] == 'bind' and found[0]['Source'] == source and found[0]['RW'] is writable,
              'required storage or trust mount changed')
    if service in ('api', 'worker'):
        check(config['User'] == '568:568', 'API user changed')
        observed = {}
        for item in config.get('Env') or []:
            key, sep, value = item.partition('=')
            check(key not in ('PROCESSING_ROOT', 'DERIVATIVES_MOUNT') or not value,
                  'unexpected storage override')
            if key in API_ENV:
                check(sep and key not in observed, 'API configuration duplicated')
                observed[key] = value
        expected_env = {**API_ENV, 'PROCESSING_WORKER_ENABLED': 'true' if service == 'worker' else 'false'}
        check(observed == expected_env, 'API/worker configuration changed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker-created', action='store_true')
    parser.add_argument('--worker-running', action='store_true')
    args = parser.parse_args()
    check(not (args.worker_created and args.worker_running), 'choose one worker state')
    verify_compose_files()
    for service, image in (('api', VIEWER_IMAGE), ('proxy', PROXY_IMAGE)):
        validate(inspect('viewer-staging-viewer-' + service + '-1'), service, image)
    if args.worker_created or args.worker_running:
        validate(inspect('viewer-staging-viewer-worker-1'), 'worker', VIEWER_IMAGE, created=args.worker_created)
    print('staging API and proxy identities match pinned configuration')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print('staging runtime preflight failed', file=sys.stderr)
        sys.exit(1)
