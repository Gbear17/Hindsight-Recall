"""SPDX-License-Identifier: GPL-3.0-only

Keyword (Recoll) indexing integration layer.

Responsible for feeding OCR text documents into Recoll and querying them
for exact/lexical matches.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, List


def index_text_files(paths: Iterable[Path]) -> int:
    """Add text files to the keyword index.

    Args:
        paths: Iterable of plaintext (possibly decrypted) text file paths.

    Returns:
        int: Count of files scheduled for indexing.
    """
    # TODO: Implement Recoll indexing invocation.
    return sum(1 for _ in paths)


def keyword_search(query: str, limit: int = 20) -> List[Path]:
    """Execute a keyword search.

    Args:
        query: User-entered query string.
        limit: Maximum number of results.

    Returns:
        list[Path]: Ranked list of matching document paths.
    """
    # TODO: Call Recoll CLI / API and parse results.
    return []