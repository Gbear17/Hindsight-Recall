"""
Simple parser for pytest junit.xml and coverage.xml produced by CI.
Usage:
  python parse_junit_and_coverage.py /path/to/test-reports

It prints:
 - number of tests / failures / errors / skipped
 - list of failed testcases and their locations (if available)
 - overall coverage percent from coverage.xml
 - top N files by missed lines
"""
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
import shutil
from datetime import datetime

def parse_junit(junit_path):
    tree = ET.parse(junit_path)
    root = tree.getroot()
    # support both <testsuites> and single <testsuite>
    suites = root.findall(".//testsuite")
    total = {"tests":0,"failures":0,"errors":0,"skipped":0}
    failed = []
    durations = []
    for s in suites:
        for k in ["tests","failures","errors","skipped"]:
            v = s.get(k)
            if v:
                total[k] += int(v)
        for tc in s.findall("testcase"):
            name = tc.get("name")
            classname = tc.get("classname")
            time = tc.get("time")
            durations.append((classname, name, float(time or 0.0)))
            # failure elements vary by runner
            if tc.find("failure") is not None or tc.find("error") is not None:
                msg = ""
                node = tc.find("failure") or tc.find("error")
                if node is not None:
                    msg = (node.get("message") or "").strip()
                failed.append((classname, name, msg))
    return total, failed, sorted(durations, key=lambda t: -t[2])[:10]

def parse_coverage(coverage_path, top_n=10):
    tree = ET.parse(coverage_path)
    root = tree.getroot()
    line_rate = root.get("line-rate") or root.get("line_rate") or ""
    try:
        percent = float(line_rate) * 100 if line_rate else None
    except Exception:
        percent = None
    # gather missed lines per file (coverage.py XML has <class filename="..."> with <lines><line ... hits="..."/>
    missed = defaultdict(int)
    for class_el in root.findall(".//class"):
        fname = class_el.get("filename")
        for line in class_el.findall(".//line"):
            hits = line.get("hits") or line.get("hits")
            number = line.get("number")
            if hits is not None and number is not None:
                try:
                    if int(hits) == 0:
                        missed[fname] += 1
                except Exception:
                    pass
    top = sorted(missed.items(), key=lambda kv: -kv[1])[:top_n]
    return percent, top

def main():
    def _find_latest_reports(search_root = None):
        """Find directories under `search_root` whose name looks like test-reports and return the newest one.

        By default searches `./tests/auto-test-reports` if present, otherwise the provided root.
        """
        def _normalize(s: str) -> str:
            return ''.join(ch for ch in s.lower() if ch.isalnum())

        workspace_reports = Path.cwd() / 'tests' / 'auto-test-reports'
        if workspace_reports.exists() and workspace_reports.is_dir():
            search_dir = workspace_reports
        else:
            search_dir = search_root or Path.cwd()

        candidates = []
        # prefer direct children (artifact folders) to avoid unrelated deep matches
        for child in search_dir.iterdir():
            try:
                if not child.is_dir():
                    continue
                n = _normalize(child.name)
                if 'testreports' in n or ('test' in n and 'report' in n):
                    candidates.append(child)
            except Exception:
                continue

        # fallback to a constrained rglob inside search_dir if no direct children matched
        if not candidates:
            for d in search_dir.rglob('*'):
                try:
                    if not d.is_dir():
                        continue
                    n = _normalize(d.name)
                    if 'testreports' in n or ('test' in n and 'report' in n):
                        candidates.append(d)
                except Exception:
                    continue

        if not candidates:
            return None
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]

    # Prefer auto-detecting the latest reports folder under tests/auto-test-reports by default
    if len(sys.argv) < 2:
        auto = _find_latest_reports()
        if auto:
            print(f"Auto-detected test-reports folder: {auto}")
            base = auto
        else:
            print("Usage: python parse_junit_and_coverage.py /path/to/test-reports")
            sys.exit(2)
    else:
        base = Path(sys.argv[1])
        # if a directory was supplied and it contains multiple report artifact folders,
        # prefer the most recently modified matching child inside it
        if base.exists() and base.is_dir():
            candidate = _find_latest_reports(base)
            if candidate:
                # if the candidate is different than the base itself, pick it
                if candidate.resolve() != base.resolve():
                    print(f"Using most-recent report folder under provided path: {candidate}")
                    base = candidate

    # If the provided path doesn't exist, try common filename variants
    def _try_alternates(p: Path):
        if p.exists():
            return p
        s = str(p)
        # try dash <-> underscore swaps and simple space->underscore
        alternates = [s.replace('-', '_'), s.replace('_', '-'), s.replace(' ', '_')]
        for a in alternates:
            alt = Path(a)
            if alt.exists():
                print(f"Note: using alternate path '{alt}' for provided path '{p}'")
                return alt
        # try neighbors in the same parent directory first (most likely)
        def _normalize(s: str) -> str:
            return ''.join(ch for ch in s.lower() if ch.isalnum())

        target_tok = _normalize(p.name)
        p_parent = p.parent
        if str(p_parent) == '.':
            p_parent = Path.cwd()
        # if parent exists, look for sibling dirs with similar normalized names
        try_parents = []
        if p_parent.exists():
            try_parents.append(p_parent)
        # also consider cwd and repository root as fallbacks
        try_parents.append(Path.cwd())

        candidates = []
        for parent in try_parents:
            for child in parent.iterdir():
                try:
                    if not child.is_dir():
                        continue
                    name_l = child.name.lower()
                    if not ('test' in name_l or 'report' in name_l):
                        continue
                    if _normalize(child.name).find(target_tok) != -1 or target_tok.find(_normalize(child.name)) != -1:
                        candidates.append(child)
                except Exception:
                    continue
            if candidates:
                print(f"Note: found similar path '{candidates[0]}' under '{parent}'")
                return candidates[0]

        # as a last resort, do a broader rglob but keep the same report-name restriction
        for cand in Path.cwd().rglob('*'):
            try:
                if not cand.is_dir():
                    continue
                name_l = cand.name.lower()
                if not ('test' in name_l or 'report' in name_l):
                    continue
                if _normalize(cand.name).find(target_tok) != -1 or target_tok.find(_normalize(cand.name)) != -1:
                    candidates.append(cand)
                    if len(candidates) >= 10:
                        break
            except Exception:
                continue

        if candidates:
            print(f"Note: found similar path '{candidates[0]}' under current directory")
            return candidates[0]
        return p

    base = _try_alternates(base)

    junit = next(base.rglob("junit.xml"), None) if base.exists() else None
    coverage = next(base.rglob("coverage.xml"), None) if base.exists() else None
    htmlcov = next(base.rglob("htmlcov"), None) if base.exists() else None

    # By default, copy discovered artifacts into a timestamped folder under
    # tests/auto-test-reports/test-reports_[ISO] so parser only writes into that workspace area.
    def _save_into_workspace(jpath, covpath, htmlpath=None):
        target_root = Path.cwd() / 'tests' / 'auto-test-reports'
        iso = datetime.utcnow().strftime('%Y-%m-%dT%H-%M-%SZ')
        dst = target_root / f'test-reports_{iso}'
        dst.mkdir(parents=True, exist_ok=True)
        saved = {}
        if jpath and jpath.exists():
            dst_j = dst / 'junit.xml'
            shutil.copy2(jpath, dst_j)
            saved['junit'] = dst_j
        if covpath and covpath.exists():
            dst_c = dst / 'coverage.xml'
            shutil.copy2(covpath, dst_c)
            saved['coverage'] = dst_c
        if htmlpath and htmlpath.exists():
            dst_h = dst / 'htmlcov'
            if dst_h.exists():
                shutil.rmtree(dst_h)
            shutil.copytree(htmlpath, dst_h)
            saved['htmlcov'] = dst_h
        return dst, saved

    # Save artifacts into workspace by default and parse the copies there
    saved_root, saved = _save_into_workspace(junit, coverage, htmlcov)
    if 'junit' in saved:
        junit = saved['junit']
    if 'coverage' in saved:
        coverage = saved['coverage']

    if not junit or not coverage:
        # helpful diagnostics
        print("Could not find junit.xml or coverage.xml under", base)
        if base.exists():
            found = [str(p.relative_to(base)) for p in base.rglob("*") if p.is_file()]
            print("Files found under provided path:")
            for f in found:
                print(" -", f)
        else:
            print("Provided path does not exist:", base)
            # show nearby candidates in cwd
            candidates = list(Path.cwd().rglob("*test-reports*"))[:10]
            if candidates:
                print("Nearby candidate report folders:")
                for c in candidates:
                    print(" -", c)
        sys.exit(1)

    total, failed, top_durations = parse_junit(junit)
    percent, top_missed = parse_coverage(coverage)

    print("JUnit summary:", total)
    if failed:
        print("\nFailed tests (count={}):".format(len(failed)))
        for cls,name,msg in failed:
            print(f" - {cls}.{name}  {msg}")
    else:
        print("\nNo failed tests found in junit.xml")

    print("\nLongest tests (top 10):")
    for cls,name,t in top_durations:
        print(f" - {cls}.{name}: {t:.3f}s")

    print("\nCoverage:")
    if percent is not None:
        print(f" - Overall line coverage: {percent:.1f}%")
    else:
        print(" - Overall line coverage: (not found in coverage.xml)")

    if top_missed:
        print("\nTop files by missed lines:")
        for fname,missed in top_missed:
            print(f" - {fname}: {missed} missed lines")
    else:
        print("\nNo per-file missed-line data found in coverage.xml")

if __name__ == '__main__':
    main()
