# Hindsight Recall

Hindsight Recall is a personal memory archive that automatically captures, indexes, encrypts, and enables intelligent searching of your desktop activity. It creates a private, fully-encrypted, searchable log of what you've seen and done on your computer, accessible through a natural language conversational interface.

## Features

### Automatic Data Capture
- Captures **screenshots of the active window only** every 5 seconds.
- Filenames include window title, date, and time for easy association:
  ```
  WINDOW-TITLE_DATE-TIME.png
  WINDOW-TITLE_DATE-TIME.txt
  ```
- Performs **OCR with Tesseract** on each screenshot.
- Stores both screenshot and OCR text locally with encryption.

### Hybrid Search Engine
- **Keyword Search (Recoll):** For exact term matches.
- **Semantic Search (FAISS):** Embedding-based similarity search.
- **Query Refinement:** Uses a **base DistilBERT model** (no training required).
- **Re-ranking:** Uses your **trained DistilBERT model** to optimize search results.

### Local AI (DistilBERT Only)
- 100% local — no external APIs required.
- DistilBERT powers:
  - Query refinement (base model)
  - Semantic embeddings (pretrained model)
  - Reranking of search results (trained model)
  - Conversational interface for Q&A and search interaction

### Encryption & Security
- **Mandatory end-to-end encryption** for all stored data (screenshots, OCR text, and indexes).
- Strong recommendation to also run on **encrypted hard drives** for maximum security.
- Configurable data retention window (30, 90, 180, or 365 days).

### Cross-Platform Support
- Linux-first, but fully designed to support **Windows and macOS**.
- No reliance on systemd-only services.

### Electron Frontend
- Modern, cross-platform desktop app interface.
- Replaces the old Open WebUI and Manager TUI.
- Provides:
  - Search bar with hybrid backend (Recoll + FAISS)
  - Conversational interface powered by DistilBERT
  - Live service health (capture, indexing, retention)
  - Resource metrics (CPU, memory, index size, pending files)
  - Configuration editor (interval, retention, exclusions)
  - **Theme toggle** (light/dark/auto) with hotkey
  - Buttons for other actions (start/stop capture, force index cycle, etc.)

## Recommended Extras
- **Exclusions:** Configurable app/window blacklist for capture.
- **Pause Modes:** Auto-pause on screen lock or system suspend.
- **Notifications:** System notifications for key events (index complete, cleanup run, errors).
- **Config Regeneration Tool:** Safely merge new configuration options with existing configs.
- **Multi-language OCR Support:** Extend capture to additional languages with Tesseract.

---

Hindsight Recall is designed to be **secure, private, cross-platform, and user-friendly**, making it the most complete open-source alternative to Microsoft Recall.

