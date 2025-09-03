import time
import json
from pathlib import Path
import base64

from capture import keymgr


def test_lockout_and_reset(tmp_path):
    base = tmp_path / 'data'
    base.mkdir()
    # create protection with a valid passphrase and get recovery token
    recovery = keymgr.create_protection(base, 'Aa1!aaaaaaaa')
    assert isinstance(recovery, str) and len(recovery) > 0
    enc = base / 'encrypted'
    assert (enc / 'key.fernet.pass').exists()
    # Record a failed attempt and check lockstate increments
    total, secs = keymgr.record_failed_attempt(base)
    assert total == 1
    state = keymgr.get_lock_info(base)
    assert state['fails'] == 1
    assert state['lock_until'] is not None
    # Simulate repeated failures up to MAX_TOTAL_ATTEMPTS
    for i in range(2, keymgr.MAX_TOTAL_ATTEMPTS):
        t, s = keymgr.record_failed_attempt(base)
        assert t == i
    # Final attempt should trigger destructive reset
    total, lock = keymgr.record_failed_attempt(base)
    assert total >= keymgr.MAX_TOTAL_ATTEMPTS
    # sensitive files should be gone
    assert not (enc / 'key.fernet.pass').exists()
    assert keymgr.get_lock_info(base)['fails'] >= keymgr.MAX_TOTAL_ATTEMPTS
