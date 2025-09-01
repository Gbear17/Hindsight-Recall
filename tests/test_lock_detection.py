"""Tests for CaptureService lock detection helpers."""

from __future__ import annotations

import subprocess
from capture.service import CaptureService


def test_loginctl_locked_yes(monkeypatch, tmp_path):
    svc = CaptureService(output_dir=tmp_path / "plain", enc_dir=tmp_path / "enc")

    def fake_check_output(cmd, timeout=1, **kwargs):
        return b"LockedHint=yes\n"

    monkeypatch.setattr(subprocess, 'check_output', fake_check_output)
    assert svc._loginctl_locked('123') is True


def test_loginctl_locked_no(monkeypatch, tmp_path):
    svc = CaptureService(output_dir=tmp_path / "plain", enc_dir=tmp_path / "enc")

    def fake_check_output(cmd, timeout=1, **kwargs):
        return b"LockedHint=no\n"

    monkeypatch.setattr(subprocess, 'check_output', fake_check_output)
    assert svc._loginctl_locked('123') is False


def test_dbus_gnome_true(monkeypatch, tmp_path):
    svc = CaptureService(output_dir=tmp_path / "plain", enc_dir=tmp_path / "enc")

    def fake_check_output(cmd, timeout=1, stderr=None, **kwargs):
        return b"(true,)"

    monkeypatch.setattr(subprocess, 'check_output', fake_check_output)
    assert svc._dbus_screensaver_gnome() is True


def test_dbus_generic_qdbus(monkeypatch, tmp_path):
    svc = CaptureService(output_dir=tmp_path / "plain", enc_dir=tmp_path / "enc")

    # First qdbus attempt -> returns 'true'
    def fake_qdbus(cmd, timeout=1, stderr=None, **kwargs):
        return b"true\n"

    monkeypatch.setattr(subprocess, 'check_output', fake_qdbus)
    assert svc._dbus_screensaver_generic() is True
