"""SPDX-License-Identifier: GPL-3.0-only

Semantic embedding generation using DistilBERT.

Provides utilities to embed text chunks and persist vectors in a FAISS index.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

try:
    import faiss  # type: ignore
    from transformers import AutoModel, AutoTokenizer  # type: ignore
    import torch  # type: ignore
except ImportError:  # pragma: no cover
    faiss = None  # type: ignore
    AutoModel = None  # type: ignore
    AutoTokenizer = None  # type: ignore
    torch = None  # type: ignore

# Optional dependency: numpy (only required when building/searching FAISS index)
try:  # pragma: no cover - optional
    import numpy as np  # type: ignore
except ImportError:  # pragma: no cover
    np = None  # type: ignore


EMBED_MODEL_NAME = "distilbert-base-uncased"


@dataclass
class EmbeddingResult:
    """Container for embedding results.

    Attributes:
        vectors: 2D list of floats (n_samples x dim).
        dim: Dimensionality of each embedding vector.
    """

    vectors: List[List[float]]
    dim: int


def load_model():  # pragma: no cover - heavyweight
    """Load embedding model resources.

    Returns:
        (tokenizer, model): The tokenizer and model instances.
    """
    if AutoTokenizer is None or AutoModel is None:
        raise RuntimeError("transformers not installed")
    tokenizer = AutoTokenizer.from_pretrained(EMBED_MODEL_NAME)
    model = AutoModel.from_pretrained(EMBED_MODEL_NAME)
    return tokenizer, model


def embed_texts(texts: Sequence[str]) -> EmbeddingResult:
    """Embed a batch of texts into dense vectors.

    Args:
        texts: Input text strings.

    Returns:
        EmbeddingResult: Embedding vectors and dimension.
    """
    if not texts:
        return EmbeddingResult(vectors=[], dim=0)
    if AutoTokenizer is None or AutoModel is None or torch is None:  # pragma: no cover
        return EmbeddingResult(vectors=[[0.0] for _ in texts], dim=1)
    tokenizer, model = load_model()
    encoded = tokenizer(list(texts), padding=True, truncation=True, return_tensors="pt")
    with torch.no_grad():
        output = model(**encoded)
    # Use mean pooling over sequence length.
    embeddings = output.last_hidden_state.mean(dim=1)
    vectors = embeddings.cpu().tolist()
    dim = len(vectors[0]) if vectors else 0
    return EmbeddingResult(vectors=vectors, dim=dim)


def build_faiss_index(embeddings: EmbeddingResult):  # pragma: no cover - heavy
    """Build an in-memory FAISS index from embeddings.

    Args:
        embeddings: EmbeddingResult to index.

    Returns:
        faiss.Index: The constructed index.
    """
    if faiss is None or np is None:
        raise RuntimeError("faiss or numpy not installed")
    if embeddings.dim == 0:
        raise ValueError("No embeddings to index (dim=0)")
    index = faiss.IndexFlatL2(embeddings.dim)
    # Convert to contiguous float32 array (n, dim)
    vectors_np = np.asarray(embeddings.vectors, dtype="float32")
    if vectors_np.ndim != 2:
        raise ValueError("Embeddings array must be 2D (n, dim)")
    n, d = vectors_np.shape
    if d != embeddings.dim:
        raise ValueError(
            f"Embedding dimension mismatch: declared {embeddings.dim} vs array {d}")
    if n == 0:
        raise ValueError("No embedding rows to index (n=0)")
    if not vectors_np.flags.c_contiguous:
        vectors_np = np.ascontiguousarray(vectors_np)
    # Call FAISS .add with contiguous (n, d) float32 matrix.
    # Some builds/stubs report a missing parameter ("n" or "x") due to differing
    # SWIG signatures (older versions expect add(self, x); others expose add(self, n, x)).
    try:  # pragma: no cover - variant handling
        index.add(vectors_np)  # type: ignore[arg-type]
    except TypeError:
        # Fallback for signature (n, x)
        index.add(n, vectors_np)  # type: ignore[misc]
    return index


def semantic_search(index, query_vectors: EmbeddingResult, k: int = 10) -> Tuple[List[int], List[float]]:  # pragma: no cover - heavy
    """Perform a semantic similarity search.

    Args:
        index: FAISS index.
        query_vectors: EmbeddingResult for the query (one vector typical).
        k: Number of nearest neighbors.

    Returns:
        tuple[list[int], list[float]]: (indices, distances)
    """
    if faiss is None or np is None:
        return [], []
    if not query_vectors.vectors:
        return [], []
    q = np.array(query_vectors.vectors, dtype="float32")
    distances, indices = index.search(q, k)
    return indices[0].tolist(), distances[0].tolist()