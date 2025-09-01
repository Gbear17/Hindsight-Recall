"""SPDX-License-Identifier: GPL-3.0-only

Hindsight Recall Search Backend package.

Exposes high-level hybrid search utilities combining:
	* Keyword search (Recoll)
	* Semantic search (DistilBERT embeddings + FAISS)
	* Reranking (fine-tuned DistilBERT model placeholder)
"""

from .hybrid import hybrid_search, SearchResult  # noqa: F401
