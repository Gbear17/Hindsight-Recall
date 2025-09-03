"""SPDX-License-Identifier: GPL-3.0-only

Screenshot capture utilities.

Provides functions to capture the active window on a configurable interval.
Implementation is OS-specific; current implementation stubs define the
interface expected by the rest of the system.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import datetime as _dt
import os
import re


@dataclass
class Screenshot:
    """Represents a single screenshot and associated metadata.

    Attributes:
        image_path: Filesystem path to the stored (encrypted) image file.
        window_title: Title of the window captured.
        timestamp: UTC timestamp when the capture occurred.
    """

    image_path: Path
    window_title: str
    timestamp: _dt.datetime


def capture_active_window(output_dir: Path) -> Screenshot:
    """Capture the currently active window.

    Args:
        output_dir: Directory where the raw screenshot (prior to encryption)
            should be saved. The caller is responsible for invoking the
            encryption layer after capture.

    Returns:
        Screenshot: Metadata describing the captured screenshot.

    Raises:
        NotImplementedError: If the platform-specific implementation has
            not yet been provided.
    """
    raise NotImplementedError("Platform-specific screenshot capture not implemented yet")


def _now_utc() -> _dt.datetime:
    """Internal indirection for UTC now (facilitates testing via monkeypatch)."""
    return _dt.datetime.now(_dt.timezone.utc)


def _current_time_with_prefs() -> _dt.datetime:
    """Compute a timezone-adjusted current timestamp based on environment prefs.

    Environment variables (set by the Electron frontend when spawning the capture service):
        HINDSIGHT_TZ_SPEC: One of 'LOCAL', 'UTC', or a fixed numeric offset like +0530 / -0800.
        HINDSIGHT_DST_ADJUST: '1' to add one hour (and shift fixed offset by +60m) else '0'.

    The return value is an aware datetime (where practical) representing the *wall clock* time in the
    chosen zone. For fixed offsets we apply the offset to UTC to produce the wall time (dropping the
    tzinfo to avoid downstream surprises since filenames only need the formatted components).
    """
    spec = os.environ.get("HINDSIGHT_TZ_SPEC", "UTC").strip().upper()
    dst_adjust = os.environ.get("HINDSIGHT_DST_ADJUST", "0") in {"1", "TRUE", "YES", "Y"}
    now_utc = _now_utc()
    # Simple helpers
    if spec == "UTC":
        dt_use = now_utc + (_dt.timedelta(hours=1) if dst_adjust else _dt.timedelta())
        return dt_use
    if spec == "LOCAL":
        # Local time with system zone info
        local = _dt.datetime.now().astimezone()
        if dst_adjust:
            local += _dt.timedelta(hours=1)
        return local
    if re.match(r"^[+-]\d{4}$", spec):
        sign = -1 if spec[0] == '-' else 1
        hours = int(spec[1:3])
        mins = int(spec[3:5])
        total_min = sign * (hours * 60 + mins)
        if dst_adjust:
            # Mirror frontend logic: simply add 60 minutes, works for +/- offsets.
            total_min += 60
        dt_use = now_utc + _dt.timedelta(minutes=total_min)
        return dt_use
    # Fallback: treat as UTC
    return now_utc + (_dt.timedelta(hours=1) if dst_adjust else _dt.timedelta())


def generate_filename(window_title: str, ts: Optional[_dt.datetime] = None) -> str:
    """Generate a standardized filename for a capture.

    Format: WINDOW-TITLE_YYYY-MM-DD_HH-MM-SS.png

    If ``ts`` is omitted we compute the current time using timezone preferences supplied via
    environment variables (set by the Electron layer). Explicit ``ts`` always wins (tests rely on
    this deterministic behavior and provide naive datetimes).
    """
    if ts is None:
        ts = _current_time_with_prefs()
    # Replace any sequence of non-alphanumeric characters with a single underscore.
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", window_title.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_") or "window"
    safe_title = cleaned[:80]
    filename = f"{safe_title}_{ts.strftime('%Y-%m-%d_%H-%M-%S')}.png"
    filename = filename.replace("\n", "").replace("\r", "")
    return filename