import importlib.util
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('space_monitor', Path(__file__).with_name('space-monitor.py'))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class SpaceMonitorTests(unittest.TestCase):
    def test_capacity_requires_both_filesystems_and_local_inodes(self):
        with patch.object(monitor, 'mount') as mounts, patch.object(monitor, 'available', side_effect=[(20, 5), (30, 4)]):
            monitor.check_capacity(10, 20, 4, '252:0')
            self.assertEqual(mounts.call_count, 2)
        for capacities in [[(9, 5), (30, 5)], [(20, 5), (19, 5)], [(20, 3), (30, 5)]]:
            with self.subTest(capacities=capacities), patch.object(monitor, 'mount'), patch.object(monitor, 'available', side_effect=capacities):
                with self.assertRaises(ValueError):
                    monitor.check_capacity(10, 20, 4, '252:0')
        with patch.object(monitor, 'mount'), patch.object(monitor, 'available', side_effect=[(20, 5), (30, 0)]):
            monitor.check_capacity(10, 20, 4, '252:0')  # CIFS inode capacity is unknown.

    def test_capacity_rejects_missing_or_malformed_measurement(self):
        for output in ('', 'Avail IAvail\n- 20\n', 'Avail IAvail\n20\n'):
            with self.subTest(output=output), patch.object(monitor, 'run', return_value=output):
                with self.assertRaises(ValueError):
                    monitor.available('/fixture')

    def test_mount_rejects_other_source_and_read_only_share(self):
        base = {'target': monitor.SHARE, 'fstype': 'cifs', 'source': monitor.SHARE_SOURCE, 'options': 'rw'}
        for change in ({'source': '//other/share'}, {'options': 'ro'}, {'target': '/wrong'}):
            data = {'filesystems': [{**base, **change}]}
            with self.subTest(change=change), patch.object(monitor, 'run', return_value=__import__('json').dumps(data)):
                with self.assertRaises(ValueError):
                    monitor.mount(monitor.SHARE, monitor.SHARE, 'cifs', monitor.SHARE_SOURCE)

    def test_exact_automount_and_cifs_pair_is_accepted_but_extra_stack_is_not(self):
        auto = {'target': monitor.SHARE, 'fstype': 'autofs', 'source': 'systemd-1', 'options': 'rw'}
        cifs = {'target': monitor.SHARE, 'fstype': 'cifs', 'source': monitor.SHARE_SOURCE, 'options': 'rw'}
        with patch.object(monitor, 'run', return_value=__import__('json').dumps({'filesystems': [auto, cifs]})):
            monitor.mount(monitor.SHARE, monitor.SHARE, 'cifs', monitor.SHARE_SOURCE)
        with patch.object(monitor, 'run', return_value=__import__('json').dumps({'filesystems': [auto, cifs, cifs]})):
            with self.assertRaises(ValueError):
                monitor.mount(monitor.SHARE, monitor.SHARE, 'cifs', monitor.SHARE_SOURCE)

    def test_systemd_socket_is_forwarded_without_unrelated_environment(self):
        with patch.dict(monitor.os.environ, {'NOTIFY_SOCKET': '/run/test-notify', 'SENSITIVE_EXAMPLE': 'not-forwarded'}, clear=True), patch.object(monitor.subprocess, 'run') as run:
            monitor.notify('--ready')
            self.assertEqual(run.call_args.kwargs['env']['NOTIFY_SOCKET'], '/run/test-notify')
            self.assertNotIn('SENSITIVE_EXAMPLE', run.call_args.kwargs['env'])
        with patch.dict(monitor.os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                monitor.notify('--ready')

    def test_failed_admission_never_signals_ready(self):
        args = ['monitor', '--root-admit', '20', '--root-stop', '10', '--share-admit', '20',
                '--share-stop', '10', '--min-inodes', '1', '--root-device', '252:0']
        with patch.object(sys, 'argv', args), patch.object(monitor, 'check_capacity', side_effect=ValueError('unavailable')), patch.object(monitor, 'notify') as notify:
            with self.assertRaises(ValueError):
                monitor.main()
            notify.assert_not_called()

    def test_failed_running_check_never_sends_another_watchdog(self):
        args = ['monitor', '--root-admit', '20', '--root-stop', '10', '--share-admit', '20',
                '--share-stop', '10', '--min-inodes', '1', '--root-device', '252:0']
        with patch.object(sys, 'argv', args), patch.object(monitor, 'check_capacity', side_effect=[None, None, ValueError('low space')]), patch.object(monitor, 'notify') as notify, patch.object(monitor.time, 'sleep'):
            with self.assertRaises(ValueError):
                monitor.main()
            self.assertEqual([call.args for call in notify.call_args_list], [('--ready',), ('WATCHDOG=1',)])


if __name__ == '__main__':
    unittest.main()
