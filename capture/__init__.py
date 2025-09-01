"""SPDX-License-Identifier: GPL-3.0-only

Hindsight Recall capture service package.

Re-exports key primitives for external callers.
"""

from .screenshot import capture_active_window, generate_filename, Screenshot  # noqa: F401
from .ocr import extract_text, ocr_text_filename  # noqa: F401
from .encryption import (
	encrypt_bytes,
	decrypt_bytes,
	encrypt_file,
	decrypt_file,
	generate_key,
)  # noqa: F401
from .service import CaptureService, build_default_service  # noqa: F401
from .active_window import get_active_window  # noqa: F401
