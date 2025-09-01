"""Unit tests for CaptureService flows using monkeypatching to avoid display I/O."""

from __future__ import annotations

import os
from pathlib import Path
import hashlib

from capture.service import CaptureService


def test_capture_once_happy_path(tmp_path: Path, stub_image_open, stub_capture_region, stub_extract_text, stub_get_active_window):
    # Prepare service with temp dirs
    plain = tmp_path / "plain"
    enc = tmp_path / "encrypted"
    svc = CaptureService(output_dir=plain, enc_dir=enc, interval=0.1, status_file=tmp_path / "status.json")
    # Run single capture iteration via internal method
    svc._capture_once()

    # Ensure encrypted dir now contains two .enc files (image + txt)
    enc_files = list(enc.glob('*.enc'))
    assert len(enc_files) == 2
    status = svc.get_status()
    assert status.get('duplicate') is False
    assert status.get('encrypted_image') is not None


def test_capture_duplicate_detection(tmp_path: Path, stub_image_open, stub_extract_text, stub_get_active_window):
    plain = tmp_path / "plain"
    enc = tmp_path / "encrypted"
    # Provide a custom fake capture that writes identical bytes
    def fake_capture_once(bbox, output_path):
        Path(output_path).write_bytes(b"DUPLICATE-BYTES-XXX")

    # Patch capture_region locally for this test
    import capture.service as _svc
    _svc.capture_region = fake_capture_once

    svc = CaptureService(output_dir=plain, enc_dir=enc, interval=0.1, status_file=tmp_path / "status.json")

    # First capture: should produce enc files
    svc._capture_once()
    first_status = svc.get_status()
    assert first_status.get('duplicate') is False

    # Second capture with same bytes => duplicate detection
    svc._capture_once()
    second_status = svc.get_status()
    assert second_status.get('duplicate') is True
