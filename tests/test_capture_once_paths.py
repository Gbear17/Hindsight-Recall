import hashlib
from pathlib import Path
import shutil
import capture.service as svc
from capture.service import CaptureService


def test_capture_duplicate_flow(tmp_path, stub_capture_region, stub_image_open, stub_extract_text, stub_get_active_window):
    plain = tmp_path / 'plain'
    enc = tmp_path / 'encrypted'
    s = CaptureService(output_dir=plain, enc_dir=enc)
    # Simulate previous capture hash equal to what stub_capture_region writes
    fake = b"FAKEPNG-BYTES"
    s._last_image_hash = hashlib.sha256(fake).hexdigest()
    prev_count = s._capture_count
    s._capture_once()
    # Should have emitted a duplicate status and not incremented capture_count
    assert s._last_status.get('duplicate') is True
    assert s._capture_count == prev_count


def test_capture_encrypt_flow(tmp_path, monkeypatch, stub_capture_region, stub_image_open, stub_extract_text, stub_get_active_window):
    plain = tmp_path / 'plain'
    enc = tmp_path / 'encrypted'
    s = CaptureService(output_dir=plain, enc_dir=enc)

    def fake_encrypt(file_path, key, enc_dir_path):
        p = Path(file_path)
        dest = Path(enc_dir_path) / (p.name + '.enc')
        dest.write_bytes(b'ENCRYPTED')
        return dest

    monkeypatch.setattr(svc, 'encrypt_file', fake_encrypt)
    prev_count = s._capture_count
    s._capture_once()
    assert s._last_status.get('duplicate') is False
    assert 'encrypted_image' in s._last_status and s._last_status['encrypted_image']
    # encrypted files should exist
    files = list(enc.glob('*.enc'))
    assert len(files) >= 2
    assert s._capture_count >= prev_count


def test_loginctl_locked_yes_and_no(monkeypatch, tmp_path):
    s = CaptureService(output_dir=tmp_path/'plain', enc_dir=tmp_path/'encrypted')
    # Locked yes
    monkeypatch.setattr(svc.subprocess, 'check_output', lambda *a, **k: b'LockedHint=yes\n')
    assert s._loginctl_locked('1') is True
    # Locked no
    monkeypatch.setattr(svc.subprocess, 'check_output', lambda *a, **k: b'LockedHint=no\n')
    assert s._loginctl_locked('1') is False
