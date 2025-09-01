"""SPDX-License-Identifier: GPL-3.0-only

Active window inspection and capture helpers.

Currently Linux-focused; other platforms provide graceful fallbacks.
"""

from __future__ import annotations

import platform
import os
import subprocess
from dataclasses import dataclass
from typing import Optional, Tuple

try:  # optional dependency used by service
    import mss  # type: ignore
    from mss.exception import ScreenShotError  # type: ignore
except ImportError:  # pragma: no cover
    mss = None  # type: ignore
    ScreenShotError = Exception  # type: ignore

_GLOBAL_MSS = None  # cached mss instance (avoid repeated open/close on X11 which can intermittently fail)
_DISPLAY_FAILURES = 0  # consecutive display open/grab failures
_BACKEND = 'mss'  # or 'imagegrab'
# Allow environment override so supervisor can force fallback without code change.
_FORCE = os.environ.get('HINDSIGHT_FORCE_BACKEND', '').strip().lower()
if _FORCE in ('imagegrab', 'mss'):
    _BACKEND = _FORCE

def _get_mss():  # pragma: no cover - depends on display
    global _GLOBAL_MSS
    if mss is None:
        return None
    if _GLOBAL_MSS is None:
        _GLOBAL_MSS = mss.mss()  # type: ignore
    return _GLOBAL_MSS


@dataclass
class WindowInfo:
    """Metadata for the active window.

    Attributes:
        title: Title string (may be 'window' fallback).
        bbox: (left, top, width, height) tuple for capture region.
    """

    title: str
    bbox: Tuple[int, int, int, int]


def _linux_active_window() -> Optional[WindowInfo]:  # pragma: no cover - environment specific
    """Return active window info using `xdotool` if available.

    Falls back to None if commands fail.
    """
    try:
        win_id = subprocess.check_output(["xdotool", "getactivewindow"], text=True).strip()
        title = subprocess.check_output(["xdotool", "getwindowname", win_id], text=True).strip() or "window"
        geom_raw = subprocess.check_output(["xdotool", "getwindowgeometry", win_id], text=True)
        # Parse line like:  Position: 123,456 (screen: 0)
        # and Geometry: 800x600
        left = top = width = height = None
        for line in geom_raw.splitlines():
            line = line.strip()
            if line.startswith("Position:"):
                # Position: 132,90 (screen: 0)
                pos_part = line.split()[1]
                xy = pos_part.split(",")
                left = int(xy[0])
                top = int(xy[1])
            elif line.startswith("Geometry:"):
                wh = line.split()[1]
                w, h = wh.split("x")
                width = int(w)
                height = int(h)
        if None in (left, top, width, height):
            return None
        # Type narrowing
        assert isinstance(left, int)
        assert isinstance(top, int)
        assert isinstance(width, int)
        assert isinstance(height, int)
        return WindowInfo(title=title, bbox=(left, top, width, height))
    except (subprocess.SubprocessError, FileNotFoundError, ValueError):
        return None


def get_active_window() -> WindowInfo:
    """Get active window info or a fullscreen fallback.

    Returns:
        WindowInfo: Active window metadata; if detection fails, uses monitor 0 size.
    """
    system = platform.system().lower()
    if system == "linux":
        info = _linux_active_window()
        if info:
            return info
    # Fallback: full screen geometry from persistent mss (if available)
    if mss is not None:  # pragma: no cover - requires display
        for attempt in (1, 2):
            try:
                sct = _get_mss()
                if sct is None:
                    break
                mon = sct.monitors[0]
                return WindowInfo(
                    title="window",
                    bbox=(mon["left"], mon["top"], mon["width"], mon["height"]),
                )
            except ScreenShotError:  # reset and retry once
                global _GLOBAL_MSS
                _GLOBAL_MSS = None
                continue
    # Last resort default size
    return WindowInfo(title="window", bbox=(0, 0, 1920, 1080))


def get_backend() -> str:
    return _BACKEND

def capture_region(bbox: Tuple[int, int, int, int], output_path: str) -> None:
    """Capture the specified screen region to a PNG file.

    Args:
        bbox: (left, top, width, height)
        output_path: File path to write PNG.
    """
    if mss is None:  # pragma: no cover
        raise RuntimeError("mss not installed for screen capture")
    left, top, width, height = bbox
    global _DISPLAY_FAILURES, _BACKEND, _GLOBAL_MSS
    region = {"left": left, "top": top, "width": width, "height": height}
    # If we've previously switched to ImageGrab (or env forced), stay on it.
    if _BACKEND == 'imagegrab':
        try:
            from PIL import ImageGrab  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("Pillow ImageGrab backend not available") from exc
        box = (left, top, left + width, top + height)
        img = ImageGrab.grab(bbox=box)  # type: ignore
        img.save(output_path, format='PNG')
        return
    # mss backend path
    attempt = 0
    while attempt < 2:  # initial + one retry
        attempt += 1
        try:
            sct = _get_mss()
            if sct is None:
                raise RuntimeError("mss not available")
            grabbed = sct.grab(region)
            try:
                from PIL import Image  # type: ignore
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError("Pillow required for capture conversion") from exc
            im = Image.frombytes("RGB", grabbed.size, grabbed.rgb)  # type: ignore
            im.save(output_path, format="PNG")
            _DISPLAY_FAILURES = 0
            return
        except ScreenShotError:
            _DISPLAY_FAILURES += 1
            _GLOBAL_MSS = None  # force re-init
            if attempt < 2:
                continue
    # After two mss failures in a row, attempt ImageGrab fallback
    try:
        from PIL import ImageGrab  # type: ignore
        box = (left, top, left + width, top + height)
        img = ImageGrab.grab(bbox=box)  # type: ignore
        img.save(output_path, format='PNG')
        _BACKEND = 'imagegrab'
        return
    except Exception as exc:  # pragma: no cover - give combined context
        raise RuntimeError(f"Display capture failed (mss + fallback). failures={_DISPLAY_FAILURES}: {exc}") from exc
