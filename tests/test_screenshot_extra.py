"""Additional tests for screenshot filename generation."""

from __future__ import annotations

import re
import datetime as dt

from capture.screenshot import generate_filename


def test_generate_filename_sanitization_and_truncate():
    # Title with punctuation and whitespace should be cleaned
    title = "  My / Very:Long*Title??? with  spaces\n"
    ts = dt.datetime(2025, 6, 7, 8, 9, 10)
    fname = generate_filename(title, ts=ts)
    # No spaces or path separators
    assert " " not in fname
    assert "/" not in fname
    assert "\\" not in fname
    # Should end with the timestamp and .png
    assert fname.endswith("2025-06-07_08-09-10.png")
    # Only allowed characters in title portion
    assert re.match(r"^[A-Za-z0-9_\-]+_2025-06-07_08-09-10\.png$", fname)


def test_generate_filename_empty_title_defaults_to_window():
    ts = dt.datetime(2025, 1, 1, 0, 0, 0)
    fname = generate_filename("   ", ts=ts)
    assert fname.startswith("window_")
    assert fname.endswith("2025-01-01_00-00-00.png")
