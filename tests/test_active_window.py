"""Tests for active window helpers using environment-driven fallbacks."""

from __future__ import annotations

import importlib
import platform
import os

from capture.active_window import get_active_window, WindowInfo, _BACKEND


def test_get_active_window_returns_windowinfo():
    # Ensure function returns a WindowInfo instance even without display
    info = get_active_window()
    assert isinstance(info, WindowInfo)
    # Bbox should be a 4-tuple of ints
    assert isinstance(info.bbox, tuple) and len(info.bbox) == 4
    for v in info.bbox:
        assert isinstance(v, int)


def test_get_backend_constant():
    # Backend is either 'mss' or 'imagegrab' depending on env
    assert _BACKEND in ("mss", "imagegrab")
