import os
from pathlib import Path
import capture.cli as cli


def test_cli_lock_busy(monkeypatch, tmp_path):
    # Simulate fcntl present but flock raises BlockingIOError
    class FakeFcntl:
        LOCK_EX = 0
        LOCK_NB = 0

        @staticmethod
        def flock(fd, flags):
            raise BlockingIOError()

    monkeypatch.setattr(cli, 'fcntl', FakeFcntl)
    # build_default_service should not be called if lock busy; provide a dummy
    monkeypatch.setattr(cli, 'build_default_service', lambda base_dir, interval=5.0: None)
    rc = cli.main(['--dir', str(tmp_path)])
    assert rc == 2


def test_cli_pidfile_live(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    pid_file.write_text(str(os.getpid()))
    # make os.kill succeed (process alive) so main returns 3
    monkeypatch.setattr(os, 'kill', lambda pid, sig: None)
    rc = cli.main(['--dir', str(tmp_path), '--pid-file', str(pid_file)])
    assert rc == 3


def test_cli_pidfile_stale_removed(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    pid_file.write_text('1')
    # Simulate os.kill raising OSError for stale pid
    def fake_kill(pid, sig):
        raise OSError('no such pid')

    monkeypatch.setattr(os, 'kill', fake_kill)
    # Provide dummy service so main proceeds to start and then returns 0
    class DummyService:
        def start(self):
            pass

        def stop(self):
            pass

    monkeypatch.setattr(cli, 'build_default_service', lambda base_dir, interval=5.0: DummyService())
    # Also disable fcntl locking for simplicity and ensure main exits quickly
    monkeypatch.setattr(cli, 'fcntl', None)
    import signal as _sig
    monkeypatch.setattr('signal.pause', lambda: (_ for _ in ()).throw(KeyboardInterrupt()))
    rc = cli.main(['--dir', str(tmp_path), '--pid-file', str(pid_file)])
    assert rc == 0
    # pid file should be removed on clean start
    assert not pid_file.exists()
