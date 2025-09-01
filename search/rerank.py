"""SPDX-License-Identifier: GPL-3.0-only

Reranking logic using a (future) fine-tuned DistilBERT model.

Takes a candidate list from hybrid search and reorders based on relevance.
"""

from __future__ import annotations

from typing import List, Sequence


def rerank(query: str, documents: Sequence[str]) -> List[int]:
    """Rerank documents for a query.

    Args:
        query: User query text.
        documents: Candidate document texts.

    Returns:
        list[int]: Indices representing a new order (highest relevance first).
    """
    # TODO: Replace with model inference.
    return list(range(len(documents)))