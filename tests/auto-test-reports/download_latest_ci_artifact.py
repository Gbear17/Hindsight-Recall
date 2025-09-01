"""Download the latest CI test-reports artifact into this directory.

Usage:
  python -m tests.auto-test-reports.download_latest_ci_artifact \
      [--repo owner/repo] [--name test-reports] [--out .]

Requirements:
  - GITHUB_TOKEN env var with at least 'repo' read permissions (PAT or workflow token)
  - 'requests' installed (already in std env) OR fall back to gh CLI if present.

Behaviour:
  1. List workflow runs (most recent successful) on main branch.
  2. Query its artifacts; find the one whose name matches (default 'test-reports').
  3. Download and extract the zip into a timestamped local folder mirroring the artifact name.
  4. Print the local path.

This is intentionally lightweight; it avoids adding new dependencies.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import urllib.request

API_ROOT = "https://api.github.com"


def _http_get(url: str, token: str | None) -> bytes:
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosec B310
        return resp.read()


def _latest_successful_run(repo: str, branch: str, token: str | None) -> Optional[dict]:
    # List workflow runs for branch, filter success
    url = f"{API_ROOT}/repos/{repo}/actions/runs?branch={branch}&per_page=30"
    data = json.loads(_http_get(url, token))
    for run in data.get("workflow_runs", []):
        if run.get("conclusion") == "success":
            return run
    return None


def _artifact_metadata(repo: str, run_id: int, token: str | None, name: str) -> Optional[dict]:
    url = f"{API_ROOT}/repos/{repo}/actions/runs/{run_id}/artifacts?per_page=50"
    data = json.loads(_http_get(url, token))
    for art in data.get("artifacts", []):
        if art.get("name") == name:
            return art
    return None


def _download_and_extract(archive_url: str, token: str | None, dest_dir: Path) -> Path:
    raw = _http_get(archive_url, token)
    # GitHub returns an application/zip
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        zf.extractall(dest_dir)
    return dest_dir


def download_latest(repo: str, artifact_name: str, branch: str, out_dir: Path, token: str | None) -> Path:
    run = _latest_successful_run(repo, branch, token)
    if not run:
        raise SystemExit(f"No successful workflow run found on branch '{branch}' for repo {repo}")
    art = _artifact_metadata(repo, run["id"], token, artifact_name)
    if not art:
        raise SystemExit(f"Artifact '{artifact_name}' not found in latest successful run {run['id']}")
    archive_url = art.get("archive_download_url")
    if not archive_url:
        raise SystemExit("Artifact has no archive_download_url")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    target = out_dir / f"{artifact_name}_download_{ts}"
    target.mkdir(parents=True, exist_ok=True)
    _download_and_extract(archive_url, token, target)
    return target


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download latest CI test-reports artifact")
    p.add_argument("--repo", default=os.getenv("GITHUB_REPOSITORY", "Gbear17/Hindsight-Recall"), help="owner/repo")
    p.add_argument("--branch", default="main")
    p.add_argument("--name", default="test-reports", help="Artifact name (default: test-reports)")
    p.add_argument("--out", default=str(Path(__file__).parent), help="Destination directory (default: this directory)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if not token:
        print("GITHUB_TOKEN (or GH_TOKEN) env var is required for authenticated API access", file=sys.stderr)
        return 2
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = download_latest(args.repo, args.name, args.branch, out_dir, token)
    print(path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
