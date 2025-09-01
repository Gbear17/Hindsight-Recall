"""SPDX-License-Identifier: GPL-3.0-only

Supervisor helpers for the detached capture service.

Provides simple PID-file based discovery and lifecycle commands so the
Electron frontend can observe / start / stop without owning the process.
"""
from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path
from typing import Optional, Dict

DEFAULT_PID_FILE = Path('data/capture.pid')


def read_pid(pid_file: Path = DEFAULT_PID_FILE) -> Optional[int]:
    try:
        pid = int(pid_file.read_text().strip())
    except Exception:
        return None
    # Check if process exists
    try:
        os.kill(pid, 0)  # signal 0 just tests
        return pid
    except OSError:
        return None


def start_detached(base_dir: Path = Path('data'), interval: float = 5.0, python: str = 'python3', pid_file: Path = DEFAULT_PID_FILE) -> Dict[str, str]:
    """Start capture service in detached/background mode if not running.

    Returns dict with keys: action (started|already), pid_file, pid (if started).
    """
    if read_pid(pid_file):
        return {"action": "already", "pid_file": str(pid_file)}
    args = [python, '-m', 'capture.cli', '--dir', str(base_dir), '--interval', str(interval), '--print-status', '--pid-file', str(pid_file)]
    # Detach: setsid & redirect stdio
    with open(os.devnull, 'wb') as devnull:
        subprocess.Popen(args, stdout=devnull, stderr=devnull, stdin=devnull, preexec_fn=os.setsid)
    return {"action": "started", "pid_file": str(pid_file)}


def stop_service(pid_file: Path = DEFAULT_PID_FILE) -> Dict[str, str]:
    pid = read_pid(pid_file)
    if not pid:
        return {"action": "not-running", "pid_file": str(pid_file)}
    try:
        os.kill(pid, signal.SIGTERM)
        return {"action": "signaled", "pid": str(pid), "pid_file": str(pid_file)}
    except OSError as e:
        return {"action": "error", "error": str(e), "pid_file": str(pid_file)}


def service_status(pid_file: Path = DEFAULT_PID_FILE) -> Dict[str, str]:
    pid = read_pid(pid_file)
    return {"running": "yes" if pid else "no", "pid": str(pid) if pid else "", "pid_file": str(pid_file)}
