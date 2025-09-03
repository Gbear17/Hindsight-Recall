import base64
from pathlib import Path
import tempfile

import pytest

from capture import keymgr


class DummyKeyring:
    def __init__(self):
        self._store = {}
    def set_password(self, service, name, value):
        self._store[(service, name)] = value
    def get_password(self, service, name):
        return self._store.get((service, name))


@pytest.fixture(autouse=True)
def monkey_keyring(monkeypatch):
    dk = DummyKeyring()
    monkeypatch.setattr(keymgr, 'keyring', dk)
    yield dk


def test_passphrase_complexity_enforced(tmp_path: Path):
    weak = 'short'
    with pytest.raises(ValueError):
        keymgr.create_protection(tmp_path, weak)


def test_create_and_validate(tmp_path: Path, monkey_keyring):
    good = 'Secur3!Passphrase'
    keymgr.create_protection(tmp_path, good)
    assert keymgr.is_protected(tmp_path)
    assert keymgr.validate_passphrase(tmp_path, good) is True
    assert keymgr.validate_passphrase(tmp_path, 'WrongPass!1') is False
