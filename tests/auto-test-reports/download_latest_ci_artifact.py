"""Download the latest successful CI test-reports artifact.

Key features:
    * Lists recent successful workflow runs on a branch and picks the newest.
    * Locates the named artifact (default: test-reports).
    * Downloads via the GitHub REST API (no external deps) with robust error messages.
    * Strips Authorization header on presigned redirect (avoids some 403 edge cases).
    * Saves into: <artifact_name>_download_<UTC> and prints the path.

Token requirements:
    * GITHUB_TOKEN / GH_TOKEN must have: repo (classic) + workflow scope, OR fine‑grained PAT with Actions: Read + Contents: Read.

Examples:
    export GITHUB_TOKEN=github_pat_xxx
    python -m tests.auto-test-reports.download_latest_ci_artifact --debug
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict
import urllib.request
import urllib.error

API = "https://api.github.com"


class _NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new and 'Authorization' in new.headers:
            # Drop auth for presigned blob URLs
            del new.headers['Authorization']
        return new


_opener = urllib.request.build_opener(_NoAuthRedirect())


def _http_get(url: str, token: str, accept_json: bool = False) -> bytes:
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "hindsight-recall-artifact-downloader",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if accept_json:
        headers["Accept"] = "application/vnd.github+json"
    req = urllib.request.Request(url, headers=headers)
    try:
        with _opener.open(req, timeout=30) as resp:  # nosec B310
            return resp.read()
    except urllib.error.HTTPError as e:  # pragma: no cover
        body = e.read().decode(errors="replace")[:400]
        if e.code == 403:
            hint = "Missing Actions: Read or artifact expired/unavailable."
        elif e.code == 404:
            hint = "Run or artifact not found (or insufficient repo access)."
        else:
            hint = e.reason
        raise SystemExit(f"HTTP {e.code} | {hint}\nURL: {url}\nBody: {body}") from e


def _latest_success(repo: str, branch: str, token: str, debug: bool) -> Optional[Dict]:
    url = f"{API}/repos/{repo}/actions/runs?branch={branch}&status=success&per_page=15"
    data = json.loads(_http_get(url, token, accept_json=True))
    runs = data.get("workflow_runs", [])
    if debug:
        for r in runs:
            print(f"[debug] run id={r['id']} conclusion={r.get('conclusion')} created={r.get('created_at')}")
    return runs[0] if runs else None


def _artifacts(repo: str, run_id: int, token: str, debug: bool) -> List[Dict]:
    url = f"{API}/repos/{repo}/actions/runs/{run_id}/artifacts"
    data = json.loads(_http_get(url, token, accept_json=True))
    arts = data.get("artifacts", [])
    if debug:
        for a in arts:
            print(f"[debug] artifact id={a['id']} name={a['name']} expired={a['expired']}")
    return arts


def _download_zip(repo: str, artifact_id: int, token: str) -> bytes:
    url = f"{API}/repos/{repo}/actions/artifacts/{artifact_id}/zip"
    return _http_get(url, token, accept_json=False)


def download_latest(repo: str, artifact_name: str, branch: str, out_dir: Path, token: str, debug: bool = False) -> Path:
    run = _latest_success(repo, branch, token, debug)
    if not run:
        raise SystemExit(f"No successful runs on branch '{branch}'.")
    run_id = run["id"]
    arts = _artifacts(repo, run_id, token, debug)
    art = next((a for a in arts if a["name"] == artifact_name and not a.get("expired")), None)
    if not art:
        raise SystemExit(f"Artifact '{artifact_name}' not found in run {run_id}. Available: {[a['name'] for a in arts]}")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    target = out_dir / f"{artifact_name}_download_{ts}"
    if debug:
        print(f"[debug] downloading artifact id={art['id']} -> {target}")
    raw = _download_zip(repo, art["id"], token)
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        zf.extractall(target)
    return target


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download latest CI test-reports artifact.")
    p.add_argument("--repo", default=os.getenv("GITHUB_REPOSITORY", "Gbear17/Hindsight-Recall"))
    p.add_argument("--branch", default="main")
    p.add_argument("--name", default="test-reports")
    p.add_argument("--out", default=str(Path(__file__).parent))
    p.add_argument("--debug", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
    if not token:
        print("Error: set GITHUB_TOKEN (PAT with repo + workflow / Actions: Read).", file=sys.stderr)
        return 2
    out_dir = Path(args.out).resolve()
    try:
        path = download_latest(args.repo, args.name, args.branch, out_dir, token, debug=args.debug)
    except SystemExit as e:
        if not args.debug:
            print(e, file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
