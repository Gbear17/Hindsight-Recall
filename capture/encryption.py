"""SPDX-License-Identifier: GPL-3.0-only

Encryption utilities for at-rest data.

Provides simple symmetric encryption (placeholder) wrappers. In production
this should use strong key management and authenticated encryption.
"""

from __future__ import annotations

from pathlib import Path
from typing import Union
import json
import base64
import os

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC  # type: ignore
from cryptography.hazmat.primitives import hashes  # type: ignore
from cryptography.hazmat.backends import default_backend  # type: ignore

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


def _derive_kek(passphrase: str, salt: bytes, iterations: int = 390000) -> bytes:
    """Derive a 32-byte key-encryption-key (urlsafe-base64 encoded for Fernet) from a passphrase."""
    if Fernet is None:
        raise RuntimeError("cryptography library not installed")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
        backend=default_backend(),
    )
    raw = kdf.derive(passphrase.encode('utf-8'))
    return base64.urlsafe_b64encode(raw)


def wrap_key_with_passphrase(data_key: bytes, passphrase: str, *, salt: bytes | None = None, iterations: int = 390000) -> bytes:
    """Wrap (encrypt) a data key using a passphrase-derived KEK.

    Returns a JSON bytes payload containing the salt, iterations and wrapped key (base64 encoded).
    """
    if salt is None:
        salt = os.urandom(16)
    if Fernet is None:
        raise RuntimeError("cryptography library not installed")
    kek = _derive_kek(passphrase, salt, iterations)
    token = Fernet(kek).encrypt(data_key)
    payload = {
        'kdf_salt': base64.b64encode(salt).decode('ascii'),
        'kdf_iters': iterations,
        'wrapped_key': base64.b64encode(token).decode('ascii'),
    }
    return json.dumps(payload, separators=(',', ':')).encode('utf-8')


def unwrap_key_with_passphrase(payload_bytes: bytes, passphrase: str) -> bytes:
    """Unwrap (decrypt) a wrapped data key payload produced by `wrap_key_with_passphrase`.

    Raises ValueError if decryption fails.
    """
    payload = json.loads(payload_bytes.decode('utf-8'))
    salt = base64.b64decode(payload['kdf_salt'])
    iterations = int(payload.get('kdf_iters', 390000))
    token = base64.b64decode(payload['wrapped_key'])
    if Fernet is None:
        raise RuntimeError("cryptography library not installed")
    kek = _derive_kek(passphrase, salt, iterations)
    return Fernet(kek).decrypt(token)


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