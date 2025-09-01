"""Tests for capture.cli argument parsing and main entry behavior."""

import capture.cli as cli
import capture.service as service
import signal
import types
import time


def test_parse_args_defaults():
    ns = cli.parse_args([])
    assert ns.base_dir == 'data'
    assert ns.interval == 5.0


def test_main_print_status(monkeypatch, tmp_path):
    # Build a dummy service that records start/stop and provides simple status
    class DummyService:
        def __init__(self):
            self.started = False
            self.stopped = False

        def start(self):
            self.started = True

        def stop(self):
            self.stopped = True

        def get_status(self):
            return {'ok': 1}

    monkeypatch.setattr(cli, 'build_default_service', lambda base_dir, interval=5.0: DummyService())
    # Prevent an infinite loop: set stop_signaled after one sleep
    # Patch the real signal and time modules so we don't accidentally miss the target
    monkeypatch.setattr(signal, 'pause', lambda: None)
    # prevent lock acquisition path in cli (fcntl present in test env)
    monkeypatch.setattr(cli, 'fcntl', None)
    # Run main with --print-status but break quickly by monkeypatching time.sleep to raise KeyboardInterrupt
    monkeypatch.setattr(time, 'sleep', lambda s: (_ for _ in ()).throw(KeyboardInterrupt()))
    # Should return 0 on normal exit
    rc = cli.main(['--print-status', '--status-interval', '0.01'])
    assert rc == 0
