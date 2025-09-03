from pathlib import Path
import subprocess
import json
import sys

from capture import keymgr


def test_autostart_key_and_get(tmp_path):
    base = tmp_path / 'data'
    base.mkdir()
    recovery = keymgr.create_protection(base, 'Aa1!aaaaaaaa')
    # autostart key should be present in keyring via get_autostart_key
    k = keymgr.get_autostart_key(base)
    assert k is not None and len(k) > 0
    # CLI --get-autostart should print the same
    py = sys.executable
    res = subprocess.run([py, '-m', 'capture.keymgr', '--base-dir', str(base), '--get-autostart'], capture_output=True, text=True)
    assert res.returncode == 0
    assert res.stdout.strip() == k
