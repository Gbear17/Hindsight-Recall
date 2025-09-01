"""Tests for capture.service helpers and lock-detection flows."""

import os
from pathlib import Path
import capture.service as svc


def test_loginctl_locked_none(monkeypatch, tmp_path):
    # Force loginctl to raise so it returns None
    instance = svc.CaptureService(output_dir=tmp_path/'plain', enc_dir=tmp_path/'encrypted')
    monkeypatch.setattr(svc.subprocess, 'check_output', lambda *a, **k: (_ for _ in ()).throw(Exception('no cmd')))
    assert instance._loginctl_locked('123') is None


def test_dbus_gnome_none(monkeypatch, tmp_path):
    instance = svc.CaptureService(output_dir=tmp_path/'plain', enc_dir=tmp_path/'encrypted')
    monkeypatch.setattr(svc.subprocess, 'check_output', lambda *a, **k: (_ for _ in ()).throw(Exception('no gdbus')))
    assert instance._dbus_screensaver_gnome() is None


def test_dbus_generic_none(monkeypatch, tmp_path):
    instance = svc.CaptureService(output_dir=tmp_path/'plain', enc_dir=tmp_path/'encrypted')
    monkeypatch.setattr(svc.subprocess, 'check_output', lambda *a, **k: (_ for _ in ()).throw(Exception('no dbus')))
    assert instance._dbus_screensaver_generic() is None


def test_write_and_get_status(tmp_path):
    instance = svc.CaptureService(output_dir=tmp_path/'plain', enc_dir=tmp_path/'encrypted')
    data = {'foo': 'bar'}
    instance._write_status(data)
    got = instance.get_status()
    # _write_status writes to filesystem and instance keeps last_status; get_status returns the in-memory copy
    assert isinstance(got, dict)
