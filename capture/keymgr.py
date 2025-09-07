"""Key management utilities for passphrase protection and lockout tracking."""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import keyring
from cryptography.fernet import Fernet

from .encryption import generate_key, wrap_key_with_passphrase, unwrap_key_with_passphrase

SERVICE_NAME = "hindsight_recall"
CHALLENGE_ENTRY = "challenge"
AUTOSTART_ENTRY = "autostart_key"
RECOVERY_TOKEN_NAME = "recovery_token"

LOCK_DURATIONS = [5 * 60, 60 * 60, 24 * 60 * 60]
MAX_TOTAL_ATTEMPTS = 12


def _enc_dir_for(base_dir: Path) -> Path:
    return base_dir / "encrypted"


def is_protected(base_dir: Path) -> bool:
    return (_enc_dir_for(base_dir) / "key.fernet.pass").exists()


def _pass_complexity_ok(p: str) -> bool:
    return (
        len(p) >= 12 and
        any(c.isupper() for c in p) and
        any(c.islower() for c in p) and
        any(c.isdigit() for c in p) and
        any(not c.isalnum() and not c.isspace() for c in p) and
        not any(c.isspace() for c in p)
    )


def _pin_ok(p: str) -> bool:
    return p.isdigit() and 4 <= len(p) <= 8


# Simple wrappers that fall back to a JSON file if system keyring fails.
def _fallback_file(base_dir: Path) -> Path:
    p = _enc_dir_for(base_dir) / 'keyring_fallback.json'
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _kr_set(base_dir: Path, name: str, value: str) -> None:
    try:
        keyring.set_password(SERVICE_NAME, name, value)
    except Exception:
        fb = _fallback_file(base_dir)
        try:
            data = json.loads(fb.read_text(encoding='utf-8')) if fb.exists() else {}
        except Exception:
            data = {}
        data.setdefault(SERVICE_NAME, {})[name] = value
        fb.write_text(json.dumps(data, indent=2), encoding='utf-8')


def _kr_get(base_dir: Path, name: str) -> Optional[str]:
    val: Optional[str]
    try:
        val = keyring.get_password(SERVICE_NAME, name)
    except Exception:
        val = None
    if val:
        return val
    # If primary returned None (or errored), attempt fallback file lookup.
    fb = _fallback_file(base_dir)
    try:
        data = json.loads(fb.read_text(encoding='utf-8')) if fb.exists() else {}
        return data.get(SERVICE_NAME, {}).get(name)
    except Exception:
        return None


def _kr_delete(base_dir: Path, name: str) -> None:
    try:
        keyring.delete_password(SERVICE_NAME, name)
    except Exception:
        fb = _fallback_file(base_dir)
        try:
            data = json.loads(fb.read_text(encoding='utf-8')) if fb.exists() else {}
            if name in data.get(SERVICE_NAME, {}):
                del data[SERVICE_NAME][name]
                fb.write_text(json.dumps(data, indent=2), encoding='utf-8')
        except Exception:
            pass


def create_protection(base_dir: Path, passphrase: str) -> str:
    # Allow either a full complexity passphrase OR a 4–8 digit PIN at creation time.
    # (Previously only complex passphrases were accepted, leading to user confusion when
    # attempting to create with a PIN directly.)
    if not (_pass_complexity_ok(passphrase) or _pin_ok(passphrase)):
        raise ValueError("Passphrase/PIN does not meet complexity requirements")
    base_dir.mkdir(parents=True, exist_ok=True)
    enc_dir = _enc_dir_for(base_dir)
    enc_dir.mkdir(parents=True, exist_ok=True)
    data_key = generate_key()
    wrapped = wrap_key_with_passphrase(data_key, passphrase)
    (enc_dir / "key.fernet.pass").write_bytes(wrapped)
    challenge = os.urandom(32)
    token = Fernet(data_key).encrypt(challenge)
    _kr_set(base_dir, CHALLENGE_ENTRY, base64.b64encode(token).decode('ascii'))
    recovery = base64.b64encode(os.urandom(32)).decode('ascii')
    _kr_set(base_dir, RECOVERY_TOKEN_NAME, recovery)
    try:
        _kr_set(base_dir, AUTOSTART_ENTRY, base64.b64encode(data_key).decode('ascii'))
    except Exception:
        pass
    (enc_dir / 'lockstate.json').write_text(json.dumps({'fails': 0, 'last_fail': None, 'lock_until': None}), encoding='utf-8')
    return recovery


def validate_passphrase(base_dir: Path, passphrase: str) -> bool:
    enc_dir = _enc_dir_for(base_dir)
    wrapped_path = enc_dir / "key.fernet.pass"
    if not wrapped_path.exists():
        return False
    try:
        payload = wrapped_path.read_bytes()
        data_key = unwrap_key_with_passphrase(payload, passphrase)
    except Exception:
        return False
    token_b64 = _kr_get(base_dir, CHALLENGE_ENTRY)
    if not token_b64:
        try:
            challenge = os.urandom(32)
            token = Fernet(data_key).encrypt(challenge)
            _kr_set(base_dir, CHALLENGE_ENTRY, base64.b64encode(token).decode('ascii'))
        except Exception:
            pass
        return True
    try:
        token = base64.b64decode(token_b64)
        Fernet(data_key).decrypt(token)
        # Ensure autostart key exists so a future autostart session can unlock silently.
        try:
            if not _kr_get(base_dir, AUTOSTART_ENTRY):
                _kr_set(base_dir, AUTOSTART_ENTRY, base64.b64encode(data_key).decode('ascii'))
        except Exception:
            pass
        return True
    except Exception:
        return False


def _get_lockstate(enc_dir: Path) -> dict:
    p = enc_dir / 'lockstate.json'
    if not p.exists():
        return {'fails': 0, 'last_fail': None, 'lock_until': None}
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return {'fails': 0, 'last_fail': None, 'lock_until': None}


def _set_lockstate(enc_dir: Path, state: dict) -> None:
    (enc_dir / 'lockstate.json').write_text(json.dumps(state), encoding='utf-8')


def record_failed_attempt(base_dir: Path) -> tuple[int, Optional[int]]:
    enc = _enc_dir_for(base_dir)
    state = _get_lockstate(enc)
    state['fails'] = state.get('fails', 0) + 1
    state['last_fail'] = datetime.now(timezone.utc).isoformat()
    total = state['fails']
    if total >= MAX_TOTAL_ATTEMPTS:
        state['lock_until'] = None
        state['reset'] = True
        _set_lockstate(enc, state)
        for fn in ['key.fernet.pass', 'ipc_info.json']:
            try:
                p = enc / fn
                if p.exists(): p.unlink()
            except Exception:
                pass
        for name in [CHALLENGE_ENTRY, RECOVERY_TOKEN_NAME, AUTOSTART_ENTRY]:
            try: _kr_delete(base_dir, name)
            except Exception: pass
        return total, None
    stage = min(len(LOCK_DURATIONS), max(0, total - 1))
    lock_seconds = LOCK_DURATIONS[stage] if stage < len(LOCK_DURATIONS) else LOCK_DURATIONS[-1]
    state['lock_until'] = (datetime.now(timezone.utc) + timedelta(seconds=lock_seconds)).isoformat()
    _set_lockstate(enc, state)
    return total, lock_seconds


def get_lock_info(base_dir: Path) -> dict:
    return _get_lockstate(_enc_dir_for(base_dir))


def get_autostart_key(base_dir: Path) -> Optional[str]:
    k = _kr_get(base_dir, AUTOSTART_ENTRY)
    if not k or not isinstance(k, str) or not k.strip():
        return None
    return k


def _read_passphrase_from_stdin() -> str:
    return sys.stdin.read().rstrip('\n')


def _main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base-dir", default="data")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--create", action="store_true")
    g.add_argument("--validate", action="store_true")
    g.add_argument("--record-fail", action="store_true")
    g.add_argument("--lock-info", action="store_true")
    g.add_argument("--get-autostart", action="store_true")
    g.add_argument("--change", action="store_true")
    p.add_argument("--use-recovery", action="store_true", help="Use recovery token instead of current passphrase for --change")
    p.add_argument("--pass-stdin", action="store_true")
    args = p.parse_args(argv or sys.argv[1:])
    base = Path(args.base_dir)
    passphrase = _read_passphrase_from_stdin() if args.pass_stdin else None
    if (args.create or args.validate) and passphrase is None:
        print("Passphrase must be sent via stdin with --pass-stdin", file=sys.stderr)
        return 2
    try:
        if args.create:
            recovery = create_protection(base, passphrase or '')
            print(recovery)
            return 0
        if args.validate:
            return 0 if validate_passphrase(base, passphrase or '') else 1
        if args.change:
            # Read two lines from stdin: first line auth secret (current pass or recovery token), second new pass/PIN.
            data = sys.stdin.read()
            lines = data.splitlines()
            if len(lines) < 2:
                print("Must supply two lines via stdin: <auth_secret>\\n<new_pass_or_pin>", file=sys.stderr)
                return 2
            auth_secret, new_secret = lines[0].rstrip('\n'), lines[1].rstrip('\n')
            if not auth_secret or not new_secret:
                print("Empty secrets not allowed", file=sys.stderr)
                return 2
            enc_dir = _enc_dir_for(base)
            wrapped_path = enc_dir / "key.fernet.pass"
            if not wrapped_path.exists():
                print("Protected key not initialized", file=sys.stderr)
                return 2
            data_key: Optional[bytes] = None
            if args.use_recovery:
                rec = _kr_get(base, RECOVERY_TOKEN_NAME)
                if not rec or rec.strip() != auth_secret.strip():
                    return 1
                # Use autostart key as the source for data key (best effort)
                ak = _kr_get(base, AUTOSTART_ENTRY)
                if not ak:
                    print("Autostart key missing; cannot change passphrase via recovery token", file=sys.stderr)
                    return 5
                try:
                    data_key = base64.b64decode(ak)
                except Exception:
                    print("Autostart key corrupted", file=sys.stderr)
                    return 5
            else:
                # Authorize with current passphrase
                if not validate_passphrase(base, auth_secret):
                    return 1
                try:
                    payload = wrapped_path.read_bytes()
                    data_key = unwrap_key_with_passphrase(payload, auth_secret)
                except Exception:
                    return 1
            # Complexity / format check for new secret (passphrase or PIN)
            if _pin_ok(new_secret):
                pass  # acceptable PIN
            elif _pass_complexity_ok(new_secret):
                pass  # acceptable full passphrase
            else:
                print("New secret does not meet PIN or passphrase complexity requirements", file=sys.stderr)
                return 3
            try:
                wrapped_new = wrap_key_with_passphrase(data_key, new_secret)
                wrapped_path.write_bytes(wrapped_new)
                # Ensure autostart key seeded (re-save existing data key)
                try: _kr_set(base, AUTOSTART_ENTRY, base64.b64encode(data_key).decode('ascii'))
                except Exception: pass
                # Rotate / (re)generate recovery token on change so user re-saves it.
                try:
                    new_rec = base64.b64encode(os.urandom(32)).decode('ascii')
                    _kr_set(base, RECOVERY_TOKEN_NAME, new_rec)
                    rec = new_rec
                except Exception:
                    rec = _kr_get(base, RECOVERY_TOKEN_NAME) or ''
                print(json.dumps({'status':'changed','recovery': rec}))
                return 0
            except Exception as e:
                print(str(e), file=sys.stderr)
                return 4
        if args.record_fail:
            total, lock_seconds = record_failed_attempt(base)
            state = get_lock_info(base)
            print(json.dumps({'total': total, 'lock_seconds': lock_seconds, 'lock_until': state.get('lock_until')}))
            return 0
        if args.lock_info:
            print(json.dumps(get_lock_info(base)))
            return 0
        if args.get_autostart:
            v = get_autostart_key(base)
            if v: print(v)
            return 0
    except ValueError as ve:
        print(str(ve), file=sys.stderr)
        return 3
    return 4


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
