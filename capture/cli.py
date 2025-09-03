"""SPDX-License-Identifier: GPL-3.0-only

Minimal CLI to run the capture service.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import os
from pathlib import Path
import time

try:  # POSIX-only; on non-POSIX we silently skip locking (best effort)
    import fcntl  # type: ignore
except Exception:  # pragma: no cover
    fcntl = None  # type: ignore

from .service import build_default_service


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run Hindsight Recall capture service")
    p.add_argument("--dir", dest="base_dir", default="data", help="Base data directory (default: data)")
    p.add_argument("--interval", type=float, default=5.0, help="Capture interval seconds (default: 5.0)")
    p.add_argument("--log-level", default="INFO", help="Logging level (default: INFO)")
    p.add_argument("--print-status", action="store_true", help="Periodically print JSON status to stdout (for external process consumption)")
    p.add_argument("--status-interval", type=float, default=2.0, help="Seconds between status prints when --print-status is set")
    p.add_argument("--pid-file", dest="pid_file", help="Optional path to write a PID file for supervision/remote control")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    logging.basicConfig(level=args.log_level.upper(), format="[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    base_dir = Path(args.base_dir)

    # --- Single instance enforcement ---
    lock_fp = None
    if fcntl is not None:
        try:
            lock_path = base_dir / 'capture.lock'
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            # Open in read/write so we can read any previous PID then overwrite.
            lock_fp = lock_path.open('a+')
            try:
                fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # Another process holds the lock; attempt to read its PID and report.
                try:
                    lock_fp.seek(0)
                    other_pid_txt = lock_fp.read().strip()
                except Exception:
                    other_pid_txt = ''
                logging.getLogger("hindsight.capture").warning(
                    "Another capture instance already running (pid=%s); exiting", other_pid_txt or '?'
                )
                return 2
            # We now hold the lock; write our PID (truncate first).
            try:
                lock_fp.seek(0)
                lock_fp.truncate()
                lock_fp.write(str(os.getpid()))
                lock_fp.flush()
            except Exception:  # pragma: no cover
                pass
        except Exception as e:  # pragma: no cover
            logging.getLogger("hindsight.capture").warning("Lock setup failed: %s (continuing without strict single-instance)", e)

    # Stale PID file handling *before* start.
    pid_path: Path | None = Path(args.pid_file) if args.pid_file else None
    if pid_path and pid_path.exists():
        try:
            existing_pid = int(pid_path.read_text().strip())
            if existing_pid > 0:
                try:
                    os.kill(existing_pid, 0)
                except OSError:
                    # stale pid file
                    pid_path.unlink(missing_ok=True)  # type: ignore[arg-type]
                else:
                    logging.getLogger("hindsight.capture").warning(
                        "Another capture instance already active (pid file %s pid=%s); exiting", pid_path, existing_pid
                    )
                    return 3
        except Exception:  # pragma: no cover
            try:
                pid_path.unlink(missing_ok=True)  # type: ignore[arg-type]
            except Exception:
                pass

    service = build_default_service(base_dir, interval=args.interval)
    if pid_path:
        try:
            tmp = pid_path.with_suffix('.tmp-' + str(os.getpid()))
            tmp.write_text(str(os.getpid()), encoding='utf-8')
            os.replace(tmp, pid_path)
        except Exception as e:  # pragma: no cover
            logging.getLogger("hindsight.capture").warning("Failed writing pid file %s: %s", pid_path, e)
    service.start()

    stop_signaled = False

    def _handle(sig, frame):  # noqa: ANN001
        nonlocal stop_signaled
        if not stop_signaled:
            logging.getLogger("hindsight.capture").info("Stopping (signal %s)", sig)
            service.stop()
            stop_signaled = True
            if pid_path and pid_path.exists():
                try:
                    pid_path.unlink()
                except Exception:  # pragma: no cover
                    pass

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)

    try:
        if args.print_status:
            # Poll in foreground; do not block on signal.pause so we can emit status.
            while not stop_signaled:
                status = service.get_status()
                if status:
                    print("STATUS::" + __import__("json").dumps(status), flush=True)
                time_sleep = getattr(__import__("time"), "sleep")
                time_sleep(max(0.5, args.status_interval))
        else:
            while not stop_signaled:
                signal.pause()
    except KeyboardInterrupt:  # pragma: no cover
        _handle("KeyboardInterrupt", None)  # type: ignore[arg-type]
    # Keep lock file handle open for life of process (if acquired) so lock is held.
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
