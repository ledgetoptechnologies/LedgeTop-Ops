import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('runtime_preflight', Path(__file__).with_name('runtime-preflight.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def fixture():
    return {'Name': '/viewer-staging-viewer-api-1', 'Image': guard.VIEWER_IMAGE,
            'Path': guard.COMMANDS['api'][0], 'Args': guard.COMMANDS['api'][1], 'HostConfig': {'ReadonlyRootfs': True},
            'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'Config': {'User': '568:568', 'Labels': {'com.docker.compose.project': 'viewer-staging',
                                  'com.docker.compose.service': 'viewer-api'},
                       'Env': [key + '=' + value for key, value in guard.API_ENV.items()]},
            'NetworkSettings': {'Networks': {name: {'NetworkID': identity, 'IPAddress': '172.23.0.3' if name.endswith('viewer-edge') else '172.30.0.2'} for name, identity in guard.NETWORKS.items()}},
            'Mounts': [{'Type': 'bind', 'Destination': dest, 'Source': src, 'RW': rw} for dest, (src, rw) in guard.API_MOUNTS.items()]}


class RuntimePreflightTests(unittest.TestCase):
    def test_created_worker_requires_stopped_state_and_worker_configuration(self):
        worker = fixture()
        worker['Name'] = '/viewer-staging-viewer-worker-1'
        worker['Config']['Labels']['com.docker.compose.service'] = 'viewer-worker'
        worker['Config']['Env'].remove('PROCESSING_WORKER_ENABLED=false')
        worker['Config']['Env'].append('PROCESSING_WORKER_ENABLED=true')
        worker['Path'], worker['Args'] = guard.COMMANDS['worker']
        worker['State'] = {'Status': 'created', 'Running': False}
        for network in worker['NetworkSettings']['Networks'].values():
            network['NetworkID'] = ''; network['IPAddress'] = ''
        guard.validate(worker, 'worker', guard.VIEWER_IMAGE, created=True)
        worker['State']['Running'] = True
        with self.assertRaises(ValueError):
            guard.validate(worker, 'worker', guard.VIEWER_IMAGE, created=True)

    def test_expected_api_passes(self):
        guard.validate(fixture(), 'api', guard.VIEWER_IMAGE)

    def test_changed_or_duplicate_critical_configuration_fails(self):
        base = fixture()
        variants = []
        item = copy.deepcopy(base); item['Image'] = 'sha256:wrong'; variants.append(item)
        item = copy.deepcopy(base); item['State']['Running'] = False; variants.append(item)
        item = copy.deepcopy(base); item['State']['Health']['Status'] = 'unhealthy'; variants.append(item)
        item = copy.deepcopy(base); item['Path'] = '/other'; variants.append(item)
        item = copy.deepcopy(base); item['HostConfig']['ReadonlyRootfs'] = False; variants.append(item)
        item = copy.deepcopy(base); item['NetworkSettings']['Networks'][next(iter(guard.NETWORKS))]['NetworkID'] = 'wrong'; variants.append(item)
        item = copy.deepcopy(base); item['NetworkSettings']['Networks']['viewer-staging_viewer-edge']['IPAddress'] = '172.23.0.4'; variants.append(item)
        item = copy.deepcopy(base); item['Mounts'][0]['Source'] = '/wrong'; variants.append(item)
        item = copy.deepcopy(base); item['Mounts'].append({'Destination': '/app/hidden', 'Source': '/other', 'RW': True}); variants.append(item)
        item = copy.deepcopy(base); item['Config']['Env'].append('PROCESSING_ROOT=/other'); variants.append(item)
        item = copy.deepcopy(base); item['Config']['Env'].append('NODE_TLS_REJECT_UNAUTHORIZED=0'); variants.append(item)
        item = copy.deepcopy(base); item['Config']['Env'].append('HTTPS_PROXY=http://wrong'); variants.append(item)
        item = copy.deepcopy(base); item['Config']['Env'].append('DATABASE_PATH=/other'); variants.append(item)
        item = copy.deepcopy(base); item['Config']['Env'].remove('CLIENT_VIEWER_SHARES_ENABLED=false'); variants.append(item)
        for item in variants:
            with self.subTest(item=item['Name']), self.assertRaises(ValueError):
                guard.validate(item, 'api', guard.VIEWER_IMAGE)


if __name__ == '__main__':
    unittest.main()
