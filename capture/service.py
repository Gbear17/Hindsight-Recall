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
import hashlib
import subprocess
import shlex

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
        self._last_image_hash = None  # hash of previous raw PNG to detect duplicates
        self._consecutive_unidentified = 0  # track consecutive UnidentifiedImageError occurrences
        self._backend_switch_reason = os.environ.get('HINDSIGHT_BACKEND_SWITCH_REASON') or None
        # Ensure directories & key
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.enc_dir.mkdir(parents=True, exist_ok=True)
        self._load_or_create_key()
        try:
            self._capture_count = sum(1 for _ in self.enc_dir.glob('*.png.enc'))
        except Exception:  # pragma: no cover - best effort
            self._capture_count = 0

    def _load_or_create_key(self) -> None:
        # Support two modes: plain key file (legacy) or passphrase-wrapped key file
        wrapped_file = self.key_file.with_suffix(self.key_file.suffix + '.pass')
        # First, prefer wrapped key if present
        if wrapped_file.exists():
            ipc_path = self.key_file.with_suffix(self.key_file.suffix + '.ipc.json')
            # Retry loop: IPC file & server race with Electron unlocking; wait a bit before giving up.
            import socket, json, base64, time as _time
            attempts = 0
            last_error: Exception | None = None
            while attempts < 8:  # ~ (0.25 + 0.5 + ... capped) < ~5s
                try:
                    if ipc_path.exists():
                        info = json.loads(ipc_path.read_text(encoding='utf-8'))
                        try:
                            with socket.create_connection((info['host'], int(info['port'])), timeout=3) as s:
                                req = json.dumps({'action': 'get_key', 'token': info['token']}) + '\n'
                                s.sendall(req.encode('utf-8'))
                                buf = b''
                                while not buf.endswith(b'\n'):
                                    chunk = s.recv(4096)
                                    if not chunk:
                                        break
                                    buf += chunk
                                resp = json.loads(buf.decode('utf-8').strip())
                                if resp.get('status') == 'ok' and 'key_b64' in resp:
                                    self._key = base64.b64decode(resp['key_b64'])
                                    LOGGER.debug("Received unwrapped key via IPC from %s after %s attempt(s)", ipc_path, attempts+1)
                                    return
                                else:
                                    last_error = RuntimeError(f"IPC unlock failed: {resp.get('msg')}")
                                    LOGGER.debug("IPC attempt %s received error response: %s", attempts+1, resp.get('msg'))
                        except Exception as exc:  # connection / decode error
                            last_error = exc
                            LOGGER.debug("IPC attempt %s exception: %s", attempts+1, exc)
                    else:
                        last_error = FileNotFoundError(f"IPC file not yet present: {ipc_path}")
                        if attempts == 0:
                            LOGGER.debug("IPC file %s not present on first attempt", ipc_path)
                except Exception as exc:
                    last_error = exc
                    LOGGER.debug("IPC attempt %s outer exception: %s", attempts+1, exc)
                attempts += 1
                _time.sleep(min(0.25 * attempts, 0.9))
            # Fallback: env var (legacy)
            passphrase = os.environ.get('HINDSIGHT_PASSPHRASE')
            if passphrase:
                try:
                    from .encryption import unwrap_key_with_passphrase
                    payload = wrapped_file.read_bytes()
                    self._key = unwrap_key_with_passphrase(payload, passphrase)
                    LOGGER.debug("Unwrapped encryption key from %s using passphrase (IPC fallback)", wrapped_file)
                    return
                except Exception as exc:  # pragma: no cover
                    last_error = exc
            # If we reach here we failed all methods
            msg = f"Failed to obtain unwrapped key after {attempts} IPC attempts: {last_error}" if last_error else 'Unknown key unwrap failure'
            LOGGER.error(msg)
            raise RuntimeError('Passphrase required but not provided (IPC not yet available)')
        if self.key_file.exists():
            # Legacy unprotected key
            self._key = self.key_file.read_bytes().strip()
            LOGGER.debug("Loaded encryption key from %s", self.key_file)
            return
        # No key exists: create new data key. If a passphrase is present, store wrapped copy
        self._key = generate_key()
        passphrase = os.environ.get('HINDSIGHT_PASSPHRASE')
        if passphrase:
            try:
                from .encryption import wrap_key_with_passphrase

                payload = wrap_key_with_passphrase(self._key, passphrase)
                wrapped_file.write_bytes(payload)
                LOGGER.info("Generated new encryption key and wrapped to %s", wrapped_file)
            except Exception:  # pragma: no cover - best effort
                # Fallback to writing plaintext key if wrapping fails
                self.key_file.write_bytes(self._key)
                LOGGER.warning("Failed to wrap key; stored plaintext key at %s", self.key_file)
        else:
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
        # Use monotonic scheduling to reduce drift: schedule based on fixed next_target.
        next_target = time.monotonic()
        while not self._stop.is_set():
            now_m = time.monotonic()
            # If we're early (can happen first iteration), realign.
            if now_m < next_target:
                # Wait the remaining time unless stop set.
                remaining_pre = next_target - now_m
                if remaining_pre > 0:
                    self._stop.wait(remaining_pre)
                if self._stop.is_set():
                    break
            start = time.time()
            try:
                if self._is_screen_locked():
                    # Emit lightweight paused status at most once per interval change
                    self._sequence += 1
                    pause_status = {
                        "last_capture_utc": datetime.now(timezone.utc).isoformat(),
                        "window_title": None,
                        "window_bbox": None,
                        "encrypted_image": None,
                        "encrypted_text": None,
                        "capture_count": self._capture_count,
                        "interval_sec": self.interval,
                        "error": None,
                        "display_env": os.environ.get('DISPLAY'),
                        "session_type": os.environ.get('XDG_SESSION_TYPE'),
                        "process_pid": os.getpid(),
                        "capture_backend": get_backend(),
                        "service_instance_id": self._instance_id,
                        "service_start_utc": self._started_utc,
                        "sequence": self._sequence,
                        "paused": True,
                        "pause_reason": "screen_locked",
                    }
                    self._last_status = pause_status
                    self._write_status(pause_status)
                else:
                    self._capture_once()
            except Exception as exc:  # pragma: no cover - safety net
                LOGGER.exception("Capture cycle failed: %s", exc)
                # Backend auto-adaptation: if repeated UnidentifiedImageError under ImageGrab, force mss next cycle.
                try:
                    from . import active_window as _aw  # type: ignore
                    if 'UnidentifiedImageError' in type(exc).__name__ or 'UnidentifiedImageError' in str(exc):
                        self._consecutive_unidentified += 1
                        if getattr(_aw, '_BACKEND', '') == 'imagegrab' and self._consecutive_unidentified >= 2:
                            setattr(_aw, '_BACKEND', 'mss')
                            setattr(_aw, '_GLOBAL_MSS', None)
                            LOGGER.warning("Switching capture backend to mss after %s consecutive UnidentifiedImageError failures", self._consecutive_unidentified)
                    else:
                        self._consecutive_unidentified = 0
                except Exception:  # pragma: no cover
                    pass
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
            # Schedule next capture strictly by incrementing next_target by interval.
            next_target += self.interval
            # If we fell behind (e.g., long OCR/encrypt), catch up but avoid tight loop; skip missed periods.
            behind = time.monotonic() - next_target
            if behind > 0:
                # Drop to current time baseline to prevent spiral of death if extremely behind.
                skips = int(behind // self.interval)
                if skips > 0:
                    next_target += self.interval * skips
            wait_duration = max(0.0, next_target - time.monotonic())
            if wait_duration > 0:
                self._stop.wait(wait_duration)

    def _capture_once(self) -> None:
        info = get_active_window()
        fname = generate_filename(info.title)
        img_path = self.output_dir / fname
        # Capture with automatic fallback: if ImageGrab yields UnidentifiedImageError, switch to mss and retry once.
        try:
            capture_region(info.bbox, str(img_path))
        except Exception as exc:
            if 'UnidentifiedImageError' in type(exc).__name__ or 'UnidentifiedImageError' in str(exc):
                try:
                    from . import active_window as _aw  # type: ignore
                    # Force backend reset to mss and retry one time.
                    _aw._BACKEND = 'mss'  # type: ignore[attr-defined]
                    _aw._GLOBAL_MSS = None  # type: ignore[attr-defined]
                    capture_region(info.bbox, str(img_path))
                except Exception:
                    raise  # propagate original failure chain
            else:
                raise
        # Validate that the file is a readable PNG; ImageGrab can sometimes write
        # a zero-byte or corrupt file on some desktops. If unreadable, retry once
        # with forced mss backend before giving up.
        try:
            from PIL import Image  # type: ignore
            with Image.open(img_path) as im:  # noqa: F841
                im.verify()  # lightweight integrity check
        except Exception as exc:  # UnidentifiedImageError or others
            if 'UnidentifiedImageError' in type(exc).__name__ or 'cannot identify image file' in str(exc):
                try:
                    # Remove bad file
                    try:
                        img_path.unlink()
                    except Exception:
                        pass
                    from . import active_window as _aw  # type: ignore
                    _aw._BACKEND = 'mss'  # type: ignore[attr-defined]
                    _aw._GLOBAL_MSS = None  # type: ignore[attr-defined]
                    # Retry capture once using mss
                    capture_region(info.bbox, str(img_path))
                    # Re-validate
                    from PIL import Image as _Image  # type: ignore
                    with _Image.open(img_path) as _im:  # noqa: F841
                        _im.verify()
                except Exception:
                    # Give up; raise original so outer loop records error status
                    raise
            else:
                raise
        # Compute hash to detect duplicate frame before heavy work (OCR/encrypt)
        try:
            raw_bytes = img_path.read_bytes()
            current_hash = hashlib.sha256(raw_bytes).hexdigest()
        except Exception:  # pragma: no cover - best effort
            current_hash = None  # type: ignore
            raw_bytes = None  # type: ignore
        duplicate = self._last_image_hash is not None and current_hash == self._last_image_hash
        if duplicate:
            # Remove newly captured duplicate file; do not increment capture_count; still emit status.
            try:
                img_path.unlink(missing_ok=True)  # type: ignore[arg-type]
            except Exception:  # pragma: no cover
                pass
            self._sequence += 1
            status = {
                "last_capture_utc": datetime.now(timezone.utc).isoformat(),
                "window_title": info.title,
                "window_bbox": info.bbox,
                "encrypted_image": None,
                "encrypted_text": None,
                "capture_count": self._capture_count,  # unchanged
                "interval_sec": self.interval,
                "display_env": os.environ.get('DISPLAY'),
                "session_type": os.environ.get('XDG_SESSION_TYPE'),
                "process_pid": os.getpid(),
                "capture_backend": get_backend(),
                "service_instance_id": self._instance_id,
                "service_start_utc": self._started_utc,
                "sequence": self._sequence,
                "duplicate": True,
            }
            self._last_status = status
            self._write_status(status)
            return
        # OCR (only for non-duplicate)
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
        # Recount encrypted image captures (authoritative).
        try:
            self._capture_count = sum(1 for _ in self.enc_dir.glob('*.png.enc'))
        except Exception:  # pragma: no cover
            pass
        self._sequence += 1
        if current_hash:
            self._last_image_hash = current_hash
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
            "duplicate": False,
            "backend_switch_reason": self._backend_switch_reason,
        }
        # Only include switch reason on first success after a switch, then clear.
        self._backend_switch_reason = None
        self._last_status = status
        self._write_status(status)
        LOGGER.debug(
            "Captured #%s and encrypted %s / %s (title=%r)",
            self._capture_count,
            enc_img.name,
            enc_txt.name,
            info.title,
        )

    # --- Lock Detection Helpers (Linux focus) ---
    def _is_screen_locked(self) -> bool:
        """Best-effort detection of locked screen (Linux KDE/GNOME)."""
        if os.name != 'posix':
            return False
        # Fast env hint (custom integration point)
        if os.environ.get('HINDSIGHT_SCREEN_LOCKED') == '1':
            return True
        # loginctl LockedHint
        sid = os.environ.get('XDG_SESSION_ID')
        if sid:
            locked = self._loginctl_locked(sid)
            if locked is not None:
                return locked
        # GNOME dbus
        val = self._dbus_screensaver_gnome()
        if val is not None:
            return val
        # KDE / freedesktop
        val = self._dbus_screensaver_generic()
        if val is not None:
            return val
        return False

    def _loginctl_locked(self, session_id: str):
        try:
            out = subprocess.check_output(['loginctl','show-session', session_id, '-p','LockedHint'], timeout=1).decode()
            m = [l for l in out.split('\n') if l.startswith('LockedHint=')]
            if m:
                return m[0].strip().split('=',1)[1].lower() == 'yes'
        except Exception:
            return None
        return None

    def _dbus_screensaver_gnome(self):
        cmd = 'gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver --method org.gnome.ScreenSaver.GetActive'
        try:
            out = subprocess.check_output(shlex.split(cmd), timeout=1, stderr=subprocess.DEVNULL).decode()
            if 'true' in out.lower():
                return True
            if 'false' in out.lower():
                return False
        except Exception:
            return None
        return None

    def _dbus_screensaver_generic(self):
        # Try qdbus then dbus-send
        try:
            out = subprocess.check_output(['qdbus','org.freedesktop.ScreenSaver','/ScreenSaver','GetActive'], timeout=1, stderr=subprocess.DEVNULL).decode().strip().lower()
            if out.startswith('true'): return True
            if out.startswith('false'): return False
        except Exception:
            pass
        try:
            out = subprocess.check_output(['dbus-send','--session','--print-reply','--dest=org.freedesktop.ScreenSaver','/ScreenSaver','org.freedesktop.ScreenSaver.GetActive'], timeout=1, stderr=subprocess.DEVNULL).decode().lower()
            if 'boolean true' in out: return True
            if 'boolean false' in out: return False
        except Exception:
            return None
        return None

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
