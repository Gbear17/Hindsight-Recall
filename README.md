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

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0). You must comply with the terms of the GPL when distributing modified or unmodified versions. See the `LICENSE` file for the full text.

## Development Setup

Install Python dependencies (ideally in a virtual environment) and Node dependencies:

```bash
pip install -r requirements.txt
(cd frontend && npm install)
```

### Git Hooks / SPDX Headers

This project uses `pre-commit` to automatically add an SPDX license header (`GPL-3.0-only`) to new Python and JavaScript source files under `capture/`, `search/`, and `frontend/`.

Enable hooks locally:

```bash
pip install pre-commit  # if not already installed
pre-commit install
```

On commit, if a file is missing the header it will be modified; re-stage and commit again.

### System Dependencies

Some components rely on system packages not available on PyPI:

- Recoll (desktop full-text indexer) provides the keyword search backend.

Install Recoll:

Debian / Ubuntu:
```bash
sudo apt update && sudo apt install -y recoll recollgui
```

Fedora:
```bash
sudo dnf install recoll
```

Arch:
```bash
sudo pacman -S recoll
```

macOS (Homebrew):
```bash
brew install recoll
```

After installing, ensure the `recoll` CLI is in PATH. Python will interface with Recoll via subprocess calls (planned) rather than a PyPI package.

### Running the Capture Service

Create and activate the virtual environment (see above), then:

```bash
python -m capture.cli --dir data --interval 5 --log-level INFO
```

Artifacts:
- Plaintext (transient) screenshots + OCR: `data/plain/` (removed after each cycle)
- Encrypted outputs: `data/encrypted/<original-filename>.png.enc` and `.txt.enc`

Plaintext files are removed after encryption. Retention enforcement is not yet implemented.

### Running the Electron UI

Launch the desktop UI (spawns the Python capture process and streams status updates):

```bash
npm install
npm start
```

What you get now:
- Automatically starts capture via `python -m capture.cli` with `--print-status`.
- Live updating status panel: last capture UTC time, window title, capture count, raw JSON.
- Status file written atomically to `data/status.json`.

Notes:
- If a `.venv` exists at project root, its Python is used; otherwise the system `python3`.
Configure interval & startup delay: use the Preferences panel in the UI (Interval controls screenshot cadence; Startup Delay adds a sleep before running at login for slower desktops).
Enable background autostart: use the UI checkbox "Run capture on login". This creates a platform-specific entry (regenerated automatically when you change interval/delay):
  - Linux: `~/.config/autostart/hindsight-recall-capture.desktop`
  - macOS: `~/Library/LaunchAgents/com.hindsight.recall.capture.plist` (load via launchd automatically on next login)
  - Windows: Startup folder batch script `HindsightRecallCapture.bat`
  Removing (unchecking) deletes the respective file.

Validate autostart: Click the "Validate Autostart" button to inspect the generated entry. The panel shows detected issues (missing file, malformed Exec line, etc.) or OK if healthy.

### Troubleshooting

No captures / stale status:
- Open the UI log panel; if you see `RuntimeError: mss not installed for screen capture` install the missing dependency inside your virtualenv:
  ```bash
  pip install mss pillow
  ```
- Verify dependencies load:
  ```bash
  python -c "import mss, PIL, cryptography, pytesseract; print('deps ok')"
  ```
- Ensure the capture process is launched from the project root (the Electron app now enforces this). If running manually, run the command from the repository root.
- An `error` field will appear in `data/status.json` while failures persist so the UI can surface root cause.
- Regenerate autostart entry (e.g. after adding an icon): uncheck "Run capture on login", then re-check it (or change and save prefs while autostart is enabled) to rewrite the `.desktop` / plist / batch script.

Alternating `ScreenShotError: Unable to open display` every other capture:
- Cause: Creating and closing a fresh `mss()` instance each cycle can intermittently fail to connect to the X11 display (especially under XWayland) leading to a repeating pattern: success, failure, success, failure.
- Fix Implemented: The service now keeps a persistent global `mss` instance and only re-initializes it after a failure. A single retry is performed immediately after the first failure before surfacing an error.
- Extra Status Fields: `display_env` (value of `$DISPLAY`), `session_type` (`$XDG_SESSION_TYPE`), and `process_pid` have been added to `status.json` for easier correlation and diagnostics.
- If the pattern continues: verify only one capture process is running (check the PID in the UI vs the pid file), ensure you're not rapidly starting/stopping (which could invalidate the cached instance), and confirm your compositor/session is stable (e.g., `echo $XDG_SESSION_TYPE`).

Force a specific capture backend (diagnostics):
- Preference `backend` (stored in `data/prefs.json`) can be set to `auto` (default), `mss`, or `imagegrab`.
- When set to `imagegrab`, the Electron supervisor exports `HINDSIGHT_FORCE_BACKEND=imagegrab` and the service skips `mss` entirely. Use this to confirm whether `mss` is the root cause of display errors.
- Environment override (advanced): you can also launch manually with `HINDSIGHT_FORCE_BACKEND=imagegrab python -m capture.cli ...`.

Capture count regression / anomaly messages:
- The UI logs `[anomaly] capture_count regressed ...` if the reported `capture_count` unexpectedly drops compared to the last observed value (beyond a small tolerance).
- This typically indicates a second capture process writing an older `status.json`, or a manual rollback / file restore.
- Action: ensure only one `capture.cli` PID exists; remove any orphaned `capture.pid` and restart from the UI.

### Desktop Autostart Icon
Place a PNG icon at `frontend/hindsight_icon.png` (this is the only icon filename the app looks for). Common square sizes: 16, 32, 48, 64, 128, 256 (a single 256x256 PNG works universally; practical max 512x512). After placing the file, regenerate the autostart entry (see above) so the `Icon=` line is included.

To remove a previously generated Linux desktop entry manually:
```bash
rm -f ~/.config/autostart/hindsight-recall-capture.desktop
```
Then re-enable autostart in the UI to regenerate it.

### Electron App Icon & Launcher Entries

The main UI window, tray icon, and autostart entries all use `frontend/hindsight_icon.png`.

Linux desktop launcher:
- On first run (after icon exists), the app auto-creates `~/.local/share/applications/hindsight-recall.desktop` if it does not already exist.
- It points `Exec` to a development command (`npm start`). For production packaging replace with the packaged binary path.
- If you modify it, it will NOT be overwritten (delete it to regenerate).

Windows shortcut (development):
- For a proper Start Menu entry and icon, package the app (e.g. with electron-builder) and set `icon` there. Development `npm start` session does not auto-create a .lnk.

macOS:
- The dock icon is set at runtime from `hindsight_icon.png` (development). For a permanent Finder icon, supply the same asset in the packaged `.app` bundle via `electron-builder` config (`icon` field, converting PNG to ICNS during build).

Packaging suggestion (electron-builder excerpt):
```jsonc
// package.json
{
  "build": {
    "appId": "com.hindsight.recall",
    "productName": "Hindsight Recall",
    "files": ["capture/**/*", "frontend/**/*", "package.json"],
    "linux": { "target": ["AppImage"], "category": "Utility", "icon": "frontend/hindsight_icon.png" },
    "win": { "target": ["nsis"], "icon": "frontend/hindsight_icon.png" },
    "mac": { "category": "public.app-category.productivity", "icon": "frontend/hindsight_icon.png" }
  }
}
```
Run packaging (after adding dev dependency):
```bash
npm install --save-dev electron-builder
npx electron-builder
```

## Testing

Unit tests are implemented with pytest. Tests avoid requiring a live display or heavyweight ML/model downloads by providing fixtures that stub display and image operations.

Quick start (inside the project root):

```bash
# (optional) create and activate a virtualenv
python -m venv .venv
source .venv/bin/activate

# install test/runtime deps
pip install -r requirements.txt
pip install pytest Pillow cryptography

# run the full test suite
python -m pytest -q
```

Helpful notes:
- The test fixtures live in `tests/conftest.py` and include:
  - `stub_image_open` — stubs `PIL.Image.open` to avoid needing real PNG files.
  - `stub_capture_region` — writes placeholder bytes instead of performing an actual screen grab.
  - `stub_extract_text` — stubs OCR extraction to return a small string.
  - `stub_get_active_window` — supplies a deterministic active-window object.
- If you want to run a single test file or test function, pass its path to pytest, for example:

```bash
python -m pytest tests/test_service_behavior.py::test_capture_once_happy_path -q
```

If your environment includes FAISS/transformers and you want to run the heavier semantic tests, install the optional deps (see `requirements.txt` and comments in `search/semantic.py`).

## Verify CI / Test runs

- On GitHub
  - Go to the repository "Actions" tab → open the latest "CI" workflow run.
  - A green check = all jobs passed; a red X = one or more jobs failed.
  - Open the `test` job to view step logs; pytest prints a summary (passed/failed/skipped) and non‑zero exit causes job failure.
  - Download artifacts from the workflow run (artifact name: `test-reports`) to get:
    - reports/junit.xml — JUnit results and failure stack traces.
    - coverage.xml — coverage report (CI enforces the coverage threshold).

- Using gh CLI
  - List runs: `gh run list --workflow ci.yml`
  - View logs for the latest run: `gh run view --log <run-id>`
  - Download artifacts: `gh run download <run-id> --name test-reports`

- Locally (run the same command as CI)
  - Install deps: `python -m pip install --upgrade pip && if [ -f requirements.txt ]; then pip install -r requirements.txt; fi && pip install pytest pytest-cov`
  - Run tests: `pytest --cov=./ --cov-report=term --cov-report=xml --cov-fail-under=70 --junitxml=reports/junit.xml`
  - Inspect `reports/junit.xml` and `coverage.xml` in the repo after the run.

Notes
- If CI did not trigger, ensure the workflow file is present at `.github/workflows/ci.yml` and the branch is `main`.
- To add a visible badge later, integrate coverage uploader (Codecov or Coveralls) and add the badge to the README.


