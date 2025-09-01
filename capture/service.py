"""SPDX-License-Identifier: GPL-3.0-only

Background capture service that periodically screenshots the active window,
performs OCR, encrypts artifacts, and manages retention stubs.
"""

from __future__ import annotations

import logging
import threading
import time
import os
from pathlib import Path
from typing import Optional, Dict, Any
import json
from datetime import datetime, timezone

from .screenshot import generate_filename
from .ocr import extract_text, ocr_text_filename
from .encryption import encrypt_file, generate_key
from .active_window import get_active_window, capture_region, get_backend
from uuid import uuid4

LOGGER = logging.getLogger("hindsight.capture")


class CaptureService:
    """Screenshot capture loop.

    Args:
        output_dir: Directory for plaintext temp artifacts (removed after encryption).
        enc_dir: Directory for encrypted outputs (.enc files).
        interval: Seconds between captures.
        key_file: Path to key file; created if missing.
    """

    def __init__(
        self,
        output_dir: Path,
        enc_dir: Path,
        interval: float = 5.0,
        key_file: Optional[Path] = None,
        status_file: Optional[Path] = None,
    ) -> None:
        self.output_dir = output_dir
        self.enc_dir = enc_dir
        self.interval = interval
        self.key_file = key_file or enc_dir / "key.fernet"
        self.status_file = status_file or enc_dir.parent / "status.json"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._key: Optional[bytes] = None
        self._capture_count = 0
        self._last_status: Dict[str, Any] = {}
        self._instance_id = uuid4().hex
        self._started_utc = datetime.now(timezone.utc).isoformat()
        self._sequence = 0  # monotonic sequence for each status write (error or success)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.enc_dir.mkdir(parents=True, exist_ok=True)
        self._load_or_create_key()
        # Initialize capture count from existing encrypted images so the
        # counter reflects all currently stored captures, not just this session.
        try:
            self._capture_count = sum(1 for _ in self.enc_dir.glob('*.png.enc'))
        except Exception:  # pragma: no cover - best effort
            self._capture_count = 0

    def _load_or_create_key(self) -> None:
        if self.key_file.exists():
            self._key = self.key_file.read_bytes().strip()
            LOGGER.debug("Loaded encryption key from %s", self.key_file)
        else:
            self._key = generate_key()
            self.key_file.write_bytes(self._key)
            LOGGER.info("Generated new encryption key at %s", self.key_file)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():  # pragma: no cover
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, name="CaptureLoop", daemon=True)
        self._thread.start()
        LOGGER.info("Capture service started (interval=%ss)", self.interval)

    def stop(self, timeout: Optional[float] = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)
            LOGGER.info("Capture service stopped")

    def _run_loop(self) -> None:
        while not self._stop.is_set():
            start = time.time()
            try:
                self._capture_once()
            except Exception as exc:  # pragma: no cover - safety net
                LOGGER.exception("Capture cycle failed: %s", exc)
                # Emit an error status so external monitors / UI can surface the issue.
                self._sequence += 1
                err_status = {
                    "last_capture_utc": datetime.now(timezone.utc).isoformat(),
                    "window_title": None,
                    "window_bbox": None,
                    "encrypted_image": None,
                    "encrypted_text": None,
                    "capture_count": self._capture_count,
                    "interval_sec": self.interval,
                    "error": f"{type(exc).__name__}: {exc}"[:500],
                    "display_env": os.environ.get('DISPLAY'),
                    "session_type": os.environ.get('XDG_SESSION_TYPE'),
                    "process_pid": os.getpid(),
                    "capture_backend": get_backend(),
                    "service_instance_id": self._instance_id,
                    "service_start_utc": self._started_utc,
                    "sequence": self._sequence,
                }
                self._last_status = err_status
                self._write_status(err_status)
            elapsed = time.time() - start
            remaining = self.interval - elapsed
            if remaining > 0:
                self._stop.wait(remaining)

    def _capture_once(self) -> None:
        info = get_active_window()
        fname = generate_filename(info.title)
        img_path = self.output_dir / fname
        capture_region(info.bbox, str(img_path))
        # OCR
        text = extract_text(img_path)
        txt_path = self.output_dir / ocr_text_filename(fname)
        txt_path.write_text(text, encoding="utf-8")
        # Encrypt both (write encrypted copies into enc_dir)
        assert self._key is not None, "Encryption key not loaded"
        enc_img = encrypt_file(img_path, self._key, self.enc_dir)
        enc_txt = encrypt_file(txt_path, self._key, self.enc_dir)
        # Remove plaintext originals
        try:
            img_path.unlink(missing_ok=True)  # type: ignore[arg-type]
            txt_path.unlink(missing_ok=True)  # type: ignore[arg-type]
        except TypeError:  # Python <3.8 compatibility fallback
            if img_path.exists():
                img_path.unlink()
            if txt_path.exists():
                txt_path.unlink()
        # Recount encrypted image captures ( authoritative ).
        try:
            self._capture_count = sum(1 for _ in self.enc_dir.glob('*.png.enc'))
        except Exception:  # pragma: no cover
            pass
        self._sequence += 1
        status = {
            "last_capture_utc": datetime.now(timezone.utc).isoformat(),
            "window_title": info.title,
            "window_bbox": info.bbox,
            "encrypted_image": enc_img.name,
            "encrypted_text": enc_txt.name,
            "capture_count": self._capture_count,
            "interval_sec": self.interval,
            "display_env": os.environ.get('DISPLAY'),
            "session_type": os.environ.get('XDG_SESSION_TYPE'),
            "process_pid": os.getpid(),
            "capture_backend": get_backend(),
            "service_instance_id": self._instance_id,
            "service_start_utc": self._started_utc,
            "sequence": self._sequence,
        }
        self._last_status = status
        self._write_status(status)
        LOGGER.debug(
            "Captured #%s and encrypted %s / %s (title=%r)",
            self._capture_count,
            enc_img.name,
            enc_txt.name,
            info.title,
        )

    def _write_status(self, status: Dict[str, Any]) -> None:
        """Atomically write status JSON.

        Writes to a temp file then renames for readers to avoid partial reads.
        """
        try:
            tmp = self.status_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.status_file)
        except Exception as exc:  # pragma: no cover - best effort
            LOGGER.debug("Failed writing status file: %s", exc)

    def get_status(self) -> Dict[str, Any]:
        """Return last in-memory status dict (may be empty before first capture)."""
        return dict(self._last_status)


def build_default_service(base_dir: Path, interval: float = 5.0) -> CaptureService:
    """Factory for a default capture service rooted at base directory.

    Layout:
        base_dir/plain/  (transient plaintext)
        base_dir/encrypted/ (.enc outputs)
    """
    plain = base_dir / "plain"
    enc = base_dir / "encrypted"
    return CaptureService(output_dir=plain, enc_dir=enc, interval=interval, status_file=base_dir / "status.json")
