"""SPDX-License-Identifier: GPL-3.0-only

Hybrid search orchestration (keyword + semantic + rerank)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from . import indexer, semantic, rerank


@dataclass
class SearchResult:
    """Unified search result entry.

    Attributes:
        doc_id: Internal identifier or path string.
        score: Final combined score after reranking.
        source: Source of initial retrieval (keyword/semantic).
    """

    doc_id: str
    score: float
    source: str


def hybrid_search(query: str, limit: int = 20) -> List[SearchResult]:
    """Perform a hybrid search and return merged results.

    Args:
        query: The natural language query.
        limit: Maximum number of results to return.

    Returns:
        list[SearchResult]: Final reranked results.
    """
    # Keyword phase (placeholder paths as strings)
    keyword_hits = [str(p) for p in indexer.keyword_search(query, limit=limit)]

    # Semantic phase (placeholder: embedding and search not wired yet)
    embeddings = semantic.embed_texts([query])
    # NOTE: Without a real FAISS index yet, semantic hits empty.
    semantic_hits: List[str] = []

    combined = keyword_hits + [h for h in semantic_hits if h not in keyword_hits]
    reranked_order = rerank.rerank(query, combined)
    results: List[SearchResult] = []
    for rank, idx in enumerate(reranked_order):
        doc_id = combined[idx]
        results.append(SearchResult(doc_id=doc_id, score=1.0 - (rank * 0.01), source="hybrid"))
        if len(results) >= limit:
            break
    return results