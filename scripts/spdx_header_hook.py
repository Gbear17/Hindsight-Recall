#!/usr/bin/env python
"""SPDX-License-Identifier: GPL-3.0-only

Pre-commit hook to ensure SPDX license identifiers are present at file top.

Rules:
    * Python (.py): Insert as first logical line. If shebang present, place after shebang.
      Preferred form: triple-quoted module docstring starting with identifier if no docstring exists,
      else single-line comment at very top if an existing docstring already present.
    * JavaScript (.js): Insert at very first line as a block or line comment `/* SPDX-License-Identifier: GPL-3.0-only */`
      unless already present in first 5 lines.

Idempotent: running multiple times won't duplicate headers.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable

SPDX_TEXT = "SPDX-License-Identifier: GPL-3.0-only"
PY_TEMPLATE = f'"""{SPDX_TEXT}\n\n<module description>\n"""\n'
JS_LINE = f"/* {SPDX_TEXT} */\n"


def has_spdx(lines: list[str]) -> bool:
    inspect_region = lines[:5]
    return any(SPDX_TEXT in l for l in inspect_region)


def process_python(path: Path) -> bool:
    original = path.read_text(encoding="utf-8").splitlines(keepends=True)
    if has_spdx(original):
        return False
    new_lines: list[str] = []
    idx = 0
    # Preserve shebang if present
    if original and original[0].startswith("#!/"):
        new_lines.append(original[0])
        idx = 1
    # If next non-empty line starts a docstring, insert a simple line comment above
    # Otherwise create a new module docstring.
    # Find first non-empty, non-shebang line
    j = idx
    while j < len(original) and original[j].strip() == "":
        j += 1
    if j < len(original) and original[j].lstrip().startswith(("'" * 3, '"' * 3)):
        new_lines.append(f"# {SPDX_TEXT}\n")
    else:
        new_lines.append(PY_TEMPLATE)
    new_lines.extend(original[idx:])
    path.write_text("".join(new_lines), encoding="utf-8")
    return True


def process_js(path: Path) -> bool:
    original = path.read_text(encoding="utf-8").splitlines(keepends=True)
    if has_spdx(original):
        return False
    new_lines = [JS_LINE] + original
    path.write_text("".join(new_lines), encoding="utf-8")
    return True


def iter_targets(files: Iterable[str]):
    for f in files:
        p = Path(f)
        if not p.exists() or p.is_dir():
            continue
        if p.suffix == ".py":
            yield p, process_python
        elif p.suffix == ".js":
            yield p, process_js


def main(argv: list[str]) -> int:
    changed = 0
    for path, fn in iter_targets(argv[1:]):
        if fn(path):
            changed += 1
            print(f"Added SPDX header: {path}")
    # If we modified files, return non-zero so git will ask user to re-stage changes.
    return 1 if changed else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv))