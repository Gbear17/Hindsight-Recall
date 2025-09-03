"""Tests for timezone-aware filename generation using environment variables.

Focuses on the backend logic that now honors HINDSIGHT_TZ_SPEC and
HINDSIGHT_DST_ADJUST when no explicit timestamp is supplied.
"""

from __future__ import annotations

import datetime as dt

from capture import screenshot


def fixed_utc():  # 2025-01-01 12:00:00Z
    return dt.datetime(2025, 1, 1, 12, 0, 0, tzinfo=dt.timezone.utc)


def test_filename_fixed_offset_no_dst(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_TZ_SPEC", "+0200")
    monkeypatch.delenv("HINDSIGHT_DST_ADJUST", raising=False)
    monkeypatch.setattr(screenshot, "_now_utc", fixed_utc)
    # +0200 should shift wall time to 14:00:00
    name = screenshot.generate_filename("TestWindow")
    assert name.startswith("TestWindow_2025-01-01_14-00-00")


def test_filename_fixed_offset_with_dst(monkeypatch):
    monkeypatch.setenv("HINDSIGHT_TZ_SPEC", "+0200")
    monkeypatch.setenv("HINDSIGHT_DST_ADJUST", "1")
    monkeypatch.setattr(screenshot, "_now_utc", fixed_utc)
    # +0200 plus DST hour => +0300 effective -> 15:00:00
    name = screenshot.generate_filename("Another")
    assert name.startswith("Another_2025-01-01_15-00-00")
