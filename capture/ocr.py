"""SPDX-License-Identifier: GPL-3.0-only

OCR extraction logic using Tesseract.

This module performs OCR over captured screenshots and returns extracted text.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

try:
    import pytesseract  # type: ignore
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - optional at scaffold stage
    pytesseract = None  # type: ignore
    Image = None  # type: ignore


def extract_text(image_path: Path, lang: str = "eng") -> str:
    """Run OCR on the provided image file.

    Args:
        image_path: Path to the image to process.
        lang: Tesseract language(s) to use.

    Returns:
        str: Extracted text (empty string if OCR unavailable).
    """
    if pytesseract is None or Image is None:
        return ""
    image = Image.open(image_path)
    return pytesseract.image_to_string(image, lang=lang)


def ocr_text_filename(screenshot_filename: str) -> str:
    """Return standardized OCR text filename from a screenshot filename.

    Args:
        screenshot_filename: The original screenshot file name.

    Returns:
        str: Derived .txt filename.
    """
    base = screenshot_filename.rsplit(".", 1)[0]
    return f"{base}.txt"