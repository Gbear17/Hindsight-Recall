"""SPDX-License-Identifier: GPL-3.0-only

Tests for lightweight semantic embedding utilities (no model download).
"""

from __future__ import annotations

import pytest

from search.semantic import embed_texts, EmbeddingResult, build_faiss_index


def test_embed_texts_empty():
    result = embed_texts([])
    assert result.vectors == []
    assert result.dim == 0


def test_build_faiss_index_no_embeddings():
    er = EmbeddingResult(vectors=[], dim=0)
    with pytest.raises(ValueError):
        build_faiss_index(er)


def test_build_faiss_index_success():
    # Skip if faiss or numpy not installed via raised RuntimeError
    try:
        er = EmbeddingResult(vectors=[[0.1, 0.2], [0.3, 0.4]], dim=2)
        index = build_faiss_index(er)
    except RuntimeError:
        pytest.skip("faiss or numpy not installed")
    assert index.ntotal == 2