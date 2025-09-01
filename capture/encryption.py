"""SPDX-License-Identifier: GPL-3.0-only

Encryption utilities for at-rest data.

Provides simple symmetric encryption (placeholder) wrappers. In production
this should use strong key management and authenticated encryption.
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

try:
    from cryptography.fernet import Fernet
except ImportError:  # pragma: no cover
    Fernet = None  # type: ignore

BytesLike = Union[bytes, bytearray]


def generate_key() -> bytes:
    """Generate a new symmetric key.

    Returns:
        bytes: A newly generated key suitable for `encrypt_bytes`.
    """
    if Fernet is None:  # pragma: no cover
        raise RuntimeError("cryptography library not installed")
    return Fernet.generate_key()


def encrypt_bytes(data: BytesLike, key: bytes) -> bytes:
    """Encrypt data using Fernet (AES-128 in CBC + HMAC wrapper).

    Args:
        data: Raw plaintext bytes.
        key: Symmetric key.

    Returns:
        bytes: Ciphertext.
    """
    if Fernet is None:  # pragma: no cover
        raise RuntimeError("cryptography library not installed")
    return Fernet(key).encrypt(bytes(data))


def decrypt_bytes(token: BytesLike, key: bytes) -> bytes:
    """Decrypt ciphertext.

    Args:
        token: Ciphertext produced by `encrypt_bytes`.
        key: Symmetric key.

    Returns:
        bytes: Decrypted plaintext.
    """
    if Fernet is None:  # pragma: no cover
        raise RuntimeError("cryptography library not installed")
    return Fernet(key).decrypt(bytes(token))


def encrypt_file(path: Path, key: bytes, dest_dir: Path | None = None) -> Path:
    """Encrypt a file and write an .enc artifact.

    By default writes alongside the original (filename.ext.enc). If ``dest_dir``
    is provided, writes to that directory instead using the same base name with
    ``.enc`` appended.

    Args:
        path: Source plaintext file path.
        key: Symmetric key bytes.
        dest_dir: Optional destination directory for encrypted output.

    Returns:
        Path: Path to encrypted file.
    """
    ciphertext = encrypt_bytes(path.read_bytes(), key)
    if dest_dir is not None:
        dest_dir.mkdir(parents=True, exist_ok=True)
        enc_path = dest_dir / (path.name + ".enc")
    else:
        enc_path = path.with_suffix(path.suffix + ".enc")
    enc_path.write_bytes(ciphertext)
    return enc_path


def decrypt_file(path: Path, key: bytes) -> bytes:
    """Decrypt an encrypted file and return plaintext bytes.

    Args:
        path: Encrypted file path.
        key: Symmetric key.

    Returns:
        bytes: Decrypted plaintext.
    """
    return decrypt_bytes(path.read_bytes(), key)