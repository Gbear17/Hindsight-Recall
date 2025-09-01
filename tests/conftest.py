"""SPDX-License-Identifier: GPL-3.0-only

Test configuration: add project root to sys.path for package imports.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest


@pytest.fixture(autouse=False)
def stub_image_open(monkeypatch):
    """Stub PIL.Image.open used by CaptureService verification steps.

    Returns a context manager implementing verify() so tests don't need
    to create real PNG data.
    """
    class DummyImg:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def verify(self):
            return None

    monkeypatch.setattr('PIL.Image.open', lambda _p: DummyImg())
    yield


@pytest.fixture(autouse=False)
def stub_capture_region(monkeypatch):
    """Stub capture_region to write placeholder bytes to the requested path."""

    def _fake_capture(bbox, output_path):
        Path(output_path).write_bytes(b"FAKEPNG-BYTES")

    monkeypatch.setattr('capture.service.capture_region', _fake_capture)
    yield _fake_capture


@pytest.fixture(autouse=False)
def stub_extract_text(monkeypatch):
    monkeypatch.setattr('capture.service.extract_text', lambda p: "extracted text")
    yield


@pytest.fixture(autouse=False)
def stub_get_active_window(monkeypatch):
    class DummyWin:
        title = "TestWindow"
        bbox = (0, 0, 10, 10)

    monkeypatch.setattr('capture.service.get_active_window', lambda: DummyWin())
    yield