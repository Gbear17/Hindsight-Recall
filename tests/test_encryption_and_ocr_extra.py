import importlib
import sys
from pathlib import Path

import capture.encryption as enc
import capture.ocr as ocr


def test_encrypt_file_missing_fernet(monkeypatch, tmp_path):
    # Simulate cryptography not installed by setting Fernet to None
    monkeypatch.setattr(enc, 'Fernet', None)
    p = tmp_path / "plain.txt"
    p.write_text("hello")
    try:
        enc.encrypt_file(p, b'somekey')
        assert False, "Expected RuntimeError when Fernet missing"
    except RuntimeError:
        pass


def test_ocr_extract_text_no_deps(monkeypatch, tmp_path):
    # Simulate pytesseract/Image not installed
    monkeypatch.setattr(ocr, 'pytesseract', None)
    monkeypatch.setattr(ocr, 'Image', None)
    img = tmp_path / "img.png"
    img.write_text("png")
    assert ocr.extract_text(img) == ""


def test_ocr_extract_text_with_deps(monkeypatch, tmp_path):
    # Provide fake Image and pytesseract
    class FakeImage:
        @staticmethod
        def open(path):
            return "imageobj"

    class FakeTess:
        @staticmethod
        def image_to_string(img, lang=None):
            return "detected text"

    monkeypatch.setattr(ocr, 'Image', FakeImage)
    monkeypatch.setattr(ocr, 'pytesseract', FakeTess)
    img = tmp_path / "img2.png"
    img.write_text("png")
    assert ocr.extract_text(img) == "detected text"
