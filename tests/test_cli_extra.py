import os
import time
import types
import signal
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
    # trigger a stop after first sleep by raising KeyboardInterrupt from time.sleep
    import time as _time
    monkeypatch.setattr(_time, 'sleep', lambda s: (_ for _ in ()).throw(KeyboardInterrupt()))

    rc = None
    rc = cli.main(["--print-status", "--status-interval", "0.01"])
    # main returns 0 on clean exit
    assert rc == 0


def test_pidfile_stale(monkeypatch, tmp_path):
    pid_file = tmp_path / "pidfile"
    # write a stale pid (non-existent process)
    pid_file.write_text("999999")
    # monkeypatch build_default_service to a dummy
    monkeypatch.setattr(cli, "build_default_service", lambda base_dir, interval: DummyService())
    # avoid lock file short-circuit
    monkeypatch.setattr(cli, 'fcntl', None)
    # prevent blocking on signal.pause() in cli.main (non --print-status path)
    monkeypatch.setattr(signal, 'pause', lambda: (_ for _ in ()).throw(KeyboardInterrupt()))
    rc = cli.main(["--pid-file", str(pid_file)])
    assert rc == 0
