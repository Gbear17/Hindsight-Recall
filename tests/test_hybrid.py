"""SPDX-License-Identifier: GPL-3.0-only

Tests for hybrid search orchestration placeholder.
"""

from __future__ import annotations

from search import hybrid_search


def test_hybrid_search_returns_list():
    results = hybrid_search("test query", limit=5)
    # Currently placeholder returns empty list; ensure type correctness.
    assert isinstance(results, list)
    assert len(results) <= 5