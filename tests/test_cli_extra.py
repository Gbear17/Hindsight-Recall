import os
import time
import types
from pathlib import Path

import capture.cli as cli


class DummyService:
    def __init__(self):
        self._running = False

    def start(self):
        self._running = True

    def stop(self):
        self._running = False

    def get_status(self):
        return {"running": self._running}


def test_main_print_status(monkeypatch, capsys, tmp_path):
    # Build a dummy service and monkeypatch build_default_service
    monkeypatch.setattr(cli, "build_default_service", lambda base_dir, interval: DummyService())
    # avoid filesystem lock interference from other tests/runs
    monkeypatch.setattr(cli, 'fcntl', None)

    # Run main with --print-status and short status_interval; ensure it prints at least once
    def run_once_sleep(secs):
        # trigger a stop after first sleep by setting stop_signaled via sending KeyboardInterrupt
        raise KeyboardInterrupt()

    monkeypatch.setattr('time.sleep', lambda s: (_ for _ in ()).throw(KeyboardInterrupt()))

    rc = None
    try:
        rc = cli.main(["--print-status", "--status-interval", "0.01"])
    except SystemExit as e:
        rc = e.code
    # main returns 0 on clean exit
    assert rc in (0, None)


def test_pidfile_stale(monkeypatch, tmp_path):
    pid_file = tmp_path / "pidfile"
    # write a stale pid (non-existent process)
    pid_file.write_text("999999")
    # monkeypatch build_default_service to a dummy
    monkeypatch.setattr(cli, "build_default_service", lambda base_dir, interval: DummyService())
    # avoid lock file short-circuit
    monkeypatch.setattr(cli, 'fcntl', None)
    rc = cli.main(["--pid-file", str(pid_file)])
    assert rc == 0
