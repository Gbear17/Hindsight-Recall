# Hindsight Recall Architecture

This document complements the main README with implementation details of the major components, data flows, and security boundaries.

## High-Level Components

1. **Electron Frontend (Node.js)**
	- Renders the UI (preferences, logs, security modals).
	- Supervises the Python capture process: start/stop, health checks, restarts, anomaly detection.
	- Enforces **single-instance** (Electron `requestSingleInstanceLock`).
	- Maintains user preferences (interval, autostart, timezone spec, DST toggle, backend override).
	- Writes frontend log lines with timezone-aware timestamps to `data/frontend.log`.
	- Launches an ephemeral unlock IPC server (Python side consumes it) for passphrase-protected key unwrap.

2. **Python Capture Service (`capture.service.CaptureService`)**
	- Monotonic scheduling loop for low-jitter periodic captures.
	- Grabs active window screenshots, validates PNG integrity, detects duplicates (SHA-256 hash) and skips redundant frames.
	- Performs OCR (Tesseract) producing a transient plaintext `.txt` alongside the image, then encrypts both.
	- Emits structured status JSON (`data/status.json`) with sequence numbers, backend info, error states, pause markers (screen lock), and instance ID.
	- Supports dynamic backend switching (ImageGrab ⇄ MSS) with reason tagging.

3. **Key Management (`capture.keymgr`)**
	- Data key generation (Fernet-compatible 32-byte key) wrapped via PBKDF2-HMAC-SHA256 (390k iterations, 16B salt).
	- Passphrase / PIN validation with lockout escalation & destructive reset after repeated failures.
	- Recovery token generation & rotation on secret change.
	- Autostart key (raw data key) stored in OS keyring (or file fallback) permitting capture to run pre‑unlock.

4. **Unlock IPC**
	- Electron starts before-passphrase-gated UI flow; Python waits for key via loop reading an `.ipc.json` file advertising host/port/token.
	- Secure local transport (loopback only) returns base64 key when token matches.

5. **Timezone & Timestamping Layer**
	- Frontend provides user preference: `logTimezone` (`LOCAL` | `UTC` | `+/-HHMM`) and `dstAdjust` boolean.
	- Filenames respect these preferences: Electron injects `HINDSIGHT_TZ_SPEC` & `HINDSIGHT_DST_ADJUST` into capture process environment; backend applies identical logic when no explicit timestamp is passed to `generate_filename`.
	- Status JSON retains canonical UTC timestamps (`last_capture_utc`) for ordering independent of localized filename formatting.

6. **Encryption Layer (`capture.encryption`)**
	- Fernet (AES-CBC + HMAC) for file encryption; plaintext screenshot + OCR removed post-encrypt.
	- Potential future migration path to stronger constructions (e.g., AES-GCM or ChaCha20-Poly1305) documented in README hardening roadmap.

## Data Flow Summary

User Action / Autostart → Electron Supervisor → Spawns Python capture with env (interval, backend, timezone spec) → Capture loop generates filename (timezone-aware) → Screenshot + OCR → Encrypt → Write `.png.enc` & `.txt.enc` → Update status.json (UTC) → Electron polls & logs → UI renders.

## Concurrency & Safety Mechanisms

- **Single Instance:** Electron + PID/flock lock in Python CLI prevents multiple capture loops.
- **Monotonic Scheduling:** Reduces drift vs wall-clock sleeps; skips forward if behind to avoid backlog spirals.
- **Duplicate Detection:** Skips encryption/OCR when frame identical to previous, reducing storage and CPU.
- **Backend Auto-Recovery:** After repeated `UnidentifiedImageError` failures under ImageGrab, switches to MSS and records a reason for diagnostics.
- **Screen Lock Pause:** Capture suppressed while locked (best-effort detection via DBus/loginctl) with explicit paused status.

## Security Boundaries

| Boundary | Control | Notes |
| -------- | ------- | ----- |
| At-rest data | Wrapped key + Fernet encryption | Plaintext only transient in `data/plain/` each cycle. |
| Unlock gating | Passphrase/PIN + lockout + destructive reset | Recovery token required post-reset for future recovery flow. |
| Autostart capture | Separate autostart key | Does not unlock UI; prevents prompt at login. |
| IPC key transfer | Localhost random port/token | Short-lived; Python retries with exponential-ish backoff. |

## Environment Variables

| Variable | Role |
| -------- | ---- |
| `HINDSIGHT_TZ_SPEC` | Timezone spec for filename timestamping. |
| `HINDSIGHT_DST_ADJUST` | DST hour adjustment toggle. |
| `HINDSIGHT_FORCE_BACKEND` | Force capture backend. |
| `HINDSIGHT_BACKEND_SWITCH_REASON` | Propagates reason for backend shift (diagnostics). |
| `HINDSIGHT_AUTOSTART` | Marker for login/autostart launches. |

## Future Extensions

- Integrity attestation (HMAC of status / IPC metadata).
- Argon2id migration for passphrase KDF.
- Incremental data rekey (stream re-encryption) for passphrase rotation.
- Fine-grained retention + secure deletion queues.

---

This architecture aims to balance *continuous capture*, *user privacy*, and *operational resilience* while staying fully local and auditable.
