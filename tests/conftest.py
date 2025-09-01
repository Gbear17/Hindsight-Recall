"""SPDX-License-Identifier: GPL-3.0-only

Test configuration: add project root to sys.path for package imports.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))