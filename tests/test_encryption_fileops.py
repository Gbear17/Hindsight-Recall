"""Tests for encrypt_file / decrypt_file flows using temporary filesystem."""

from __future__ import annotations

from pathlib import Path
import tempfile

from capture.encryption import generate_key, encrypt_file, decrypt_file


def test_encrypt_and_decrypt_file_roundtrip(tmp_path: Path):
    key = generate_key()
    src = tmp_path / "plain.txt"
    src.write_text("hello-encrypt", encoding="utf-8")
    enc_dir = tmp_path / "enc"
    enc_path = encrypt_file(src, key, dest_dir=enc_dir)
    assert enc_path.exists()
    # Original still exists (encrypt_file writes but does not remove source)
    assert src.exists()
    recovered = decrypt_file(enc_path, key)
    assert recovered.decode("utf-8") == "hello-encrypt"
