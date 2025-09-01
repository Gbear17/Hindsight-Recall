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


def generate_filename(window_title: str, ts: Optional[_dt.datetime] = None) -> str:
    """Generate a standardized filename for a capture.

    The format follows the convention: WINDOW-TITLE_DATE-TIME.png

    Args:
        window_title: Title of the window.
        ts: Optional timestamp; if omitted, UTC now is used.

    Returns:
        str: Sanitized filename (without path) for the screenshot.
    """
    ts = ts or _dt.datetime.utcnow()
    # Replace any sequence of non-alphanumeric characters with a single underscore.
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", window_title.strip())
    # Collapse multiple underscores, strip leading/trailing underscores.
    cleaned = re.sub(r"_+", "_", cleaned).strip("_") or "window"
    safe_title = cleaned[:80]
    filename = f"{safe_title}_{ts.strftime('%Y-%m-%d_%H-%M-%S')}.png"
    # Defensive: remove accidental newlines/carriage returns.
    filename = filename.replace("\n", "").replace("\r", "")
    return filename