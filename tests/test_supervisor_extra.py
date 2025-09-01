"""Tests for capture.supervisor helpers."""

from pathlib import Path
import os
import subprocess

import capture.supervisor as sup


def test_read_pid_no_file(tmp_path):
    p = tmp_path / "no.pid"
    assert sup.read_pid(p) is None


def test_read_pid_live(tmp_path):
    p = tmp_path / "live.pid"
    p.write_text(str(os.getpid()))
    pid = sup.read_pid(p)
    assert pid == os.getpid()


def test_read_pid_stale(tmp_path, monkeypatch):
    p = tmp_path / "stale.pid"
    p.write_text("1")
    # ensure os.kill for PID 1 raises OSError in our environment
    monkeypatch.setattr(os, 'kill', lambda pid, sig: (_ for _ in ()).throw(OSError("no such pid")))
    assert sup.read_pid(p) is None


def test_start_detached_already(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    # Simulate already running
    monkeypatch.setattr(sup, 'read_pid', lambda pf=pid_file: 1234)
    res = sup.start_detached(base_dir=tmp_path, interval=1.0, python='python', pid_file=pid_file)
    assert res.get('action') == 'already'


def test_start_detached_started(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    monkeypatch.setattr(sup, 'read_pid', lambda pf=pid_file: None)

    class DummyPopen:
        def __init__(self, *a, **k):
            self.args = a

    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **k: DummyPopen())
    res = sup.start_detached(base_dir=tmp_path, interval=1.5, python='python3', pid_file=pid_file)
    assert res.get('action') == 'started'


def test_stop_service_not_running(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    monkeypatch.setattr(sup, 'read_pid', lambda pf=pid_file: None)
    res = sup.stop_service(pid_file=pid_file)
    assert res.get('action') == 'not-running'


def test_stop_service_signaled(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    monkeypatch.setattr(sup, 'read_pid', lambda pf=pid_file: 99999)
    called = {}

    def fake_kill(pid, sig):
        called['pid'] = pid
        called['sig'] = sig

    monkeypatch.setattr(os, 'kill', fake_kill)
    res = sup.stop_service(pid_file=pid_file)
    assert res.get('action') == 'signaled'
    import signal as _sig
    assert called['sig'] == _sig.SIGTERM


def test_service_status_reports(monkeypatch, tmp_path):
    pid_file = tmp_path / 'capture.pid'
    monkeypatch.setattr(sup, 'read_pid', lambda pf=pid_file: None)
    st = sup.service_status(pid_file=pid_file)
    assert st['running'] == 'no'