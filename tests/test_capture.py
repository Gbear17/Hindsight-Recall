"""SPDX-License-Identifier: GPL-3.0-only

Tests for capture-related utility functions.
"""

from __future__ import annotations

import re
import datetime as dt

from capture.screenshot import generate_filename
from capture.ocr import ocr_text_filename
from capture.encryption import generate_key, encrypt_bytes, decrypt_bytes


def test_generate_filename_basic():
    ts = dt.datetime(2025, 1, 2, 3, 4, 5)
    fname = generate_filename("My Window Title", ts=ts)
    assert fname.endswith("2025-01-02_03-04-05.png")
    # Ensure spaces replaced with underscores and no path separators
    assert " " not in fname
    assert "/" not in fname
    # Matches pattern <title>_YYYY-MM-DD_HH-MM-SS.png
    # Correct pattern: single literal dot before extension. Previous version
    # erroneously required a backslash character in the filename.
    assert re.match(r"^[A-Za-z0-9_\-]+_2025-01-02_03-04-05\.png$", fname)


def test_ocr_text_filename_conversion():
    assert ocr_text_filename("Example_2025-01-02_03-04-05.png") == "Example_2025-01-02_03-04-05.txt"


def test_encrypt_decrypt_roundtrip():
    key = generate_key()
    plaintext = b"secret-data-123"
    token = encrypt_bytes(plaintext, key)
    assert token != plaintext
    recovered = decrypt_bytes(token, key)
    assert recovered == plaintext