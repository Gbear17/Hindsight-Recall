"""SPDX-License-Identifier: GPL-3.0-only

Centralized logging configuration for Python capture components.
Provides:
  configure_logging(level:str='INFO', json_mode:bool=False, rotate_mb:int=2)
  set_runtime_level(level:str)
  get_runtime_level() -> str

Features:
  * Singleton root logger setup (idempotent).
  * Level threshold control and runtime adjustment.
  * Optional JSON structured log lines (side-by-side human format).
  * Basic size-based rotation (single .1 rollover).

This prepares parity with the Electron-side centralized logger.
"""
from __future__ import annotations
import logging, os, sys, json, threading, time
from pathlib import Path
from typing import Optional

_LOCK = threading.Lock()
_CONFIGURED = False
_CURRENT_LEVEL = 'INFO'
_JSON_MODE = False
_ROTATE_MB = 2
_LOG_PATH: Optional[Path] = None

LEVEL_ORDER = ['TRACE','DEBUG','INFO','WARNING','ERROR','CRITICAL']

class _TraceLevelFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        return True

def _level_index(l: str) -> int:
    try:
        return LEVEL_ORDER.index(l.upper())
    except ValueError:
        return 2

class _SizedRotatingHandler(logging.Handler):
    def __init__(self, path: Path, rotate_mb: int) -> None:
        super().__init__()
        self.path = path
        self.rotate_bytes = max(1, min(rotate_mb, 64)) * 1024 * 1024
        self._ensure_dir()

    def _ensure_dir(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        try:
            msg = self.format(record)
            data = msg + '\n'
            # rotate if needed
            try:
                if self.path.exists() and self.path.stat().st_size + len(data.encode('utf-8')) > self.rotate_bytes:
                    r = self.path.with_suffix(self.path.suffix + '.1')
                    try: r.unlink()
                    except Exception: pass
                    try: self.path.rename(r)
                    except Exception: pass
            except Exception:  # pragma: no cover
                pass
            with self.path.open('a', encoding='utf-8') as fh:
                fh.write(data)
        except Exception:  # pragma: no cover
            try:
                sys.stderr.write('log handler failure\n')
            except Exception:
                pass

class _DualFormatter(logging.Formatter):
    def __init__(self, json_mode: bool):
        super().__init__()
        self.json_mode = json_mode

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        base = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(record.created)) + f".{int(record.msecs):03d}Z",
            'level': record.levelname,
            'logger': record.name,
            'msg': record.getMessage(),
        }
        if record.exc_info:
            base['exc'] = self.formatException(record.exc_info)
        if self.json_mode:
            try:
                return json.dumps(base, ensure_ascii=False)
            except Exception:
                return f"{base['ts']} {base['level']} {base['logger']}: {base['msg']}"
        return f"[{base['ts']}] {base['level']} {base['logger']}: {base['msg']}"


def configure_logging(level: str = 'INFO', json_mode: bool = False, rotate_mb: int = 2, log_path: Optional[Path] = None) -> None:
    global _CONFIGURED, _CURRENT_LEVEL, _JSON_MODE, _ROTATE_MB, _LOG_PATH
    with _LOCK:
        _CURRENT_LEVEL = (level or 'INFO').upper()
        _JSON_MODE = bool(json_mode)
        _ROTATE_MB = rotate_mb if rotate_mb and rotate_mb > 0 else 2
        if _ROTATE_MB > 64: _ROTATE_MB = 64
        if _CONFIGURED:
            set_runtime_level(_CURRENT_LEVEL)
            return
        # Determine log path
        base_dir = Path(os.environ.get('HINDSIGHT_BASE_DIR') or 'data')
        if not log_path:
            log_path = base_dir / 'capture.stdout.log'
        _LOG_PATH = log_path
        handler = _SizedRotatingHandler(log_path, _ROTATE_MB)
        formatter = _DualFormatter(_JSON_MODE)
        handler.setFormatter(formatter)
        root = logging.getLogger()
        root.setLevel(_CURRENT_LEVEL)
        # Remove default handlers to avoid duplicate lines
        for h in list(root.handlers):
            root.removeHandler(h)
        root.addHandler(handler)
        # Add TRACE alias if desired (map to DEBUG in stdlib)
        logging.addLevelName(5, 'TRACE')
        def trace(self, msg, *args, **kwargs):  # pragma: no cover - convenience
            if self.isEnabledFor(5):
                self._log(5, msg, args, **kwargs)
        logging.Logger.trace = trace  # type: ignore[attr-defined]
        _CONFIGURED = True


def set_runtime_level(level: str) -> None:
    global _CURRENT_LEVEL
    with _LOCK:
        _CURRENT_LEVEL = (level or 'INFO').upper()
        root = logging.getLogger()
        root.setLevel(_CURRENT_LEVEL)


def get_runtime_level() -> str:
    return _CURRENT_LEVEL

__all__ = ['configure_logging','set_runtime_level','get_runtime_level']
