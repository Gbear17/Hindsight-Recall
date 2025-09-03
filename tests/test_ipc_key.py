import base64
import json
import socket
import threading
import tempfile
from pathlib import Path

import pytest

from capture.service import CaptureService


def run_dummy_server(host, port, token, key_b64, ready_evt):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(1)
    ready_evt.set()
    conn, _ = srv.accept()
    data = b''
    while not data.endswith(b'\n'):
        chunk = conn.recv(4096)
        if not chunk:
            break
        data += chunk
    try:
        req = json.loads(data.decode('utf-8').strip())
        if req.get('token') == token and req.get('action') == 'get_key':
            resp = {'status': 'ok', 'key_b64': key_b64}
        else:
            resp = {'status': 'error', 'msg': 'invalid'}
    except Exception:
        resp = {'status': 'error', 'msg': 'bad'}
    conn.sendall((json.dumps(resp) + '\n').encode('utf-8'))
    conn.close()
    srv.close()


def test_service_uses_ipc(tmp_path: Path):
    # Prepare a wrapped key placeholder (content not used by the test server)
    enc_dir = tmp_path / 'encrypted'
    enc_dir.mkdir(parents=True)
    (enc_dir / 'key.fernet.pass').write_bytes(b'{}')
    # Prepare dummy key
    dummy_key = b'0' * 32
    key_b64 = base64.b64encode(dummy_key).decode('ascii')
    # Start dummy server on ephemeral port
    host = '127.0.0.1'
    s = socket.socket()
    s.bind((host, 0))
    port = s.getsockname()[1]
    s.close()
    token = 'deadbeef'
    ready = threading.Event()
    t = threading.Thread(target=run_dummy_server, args=(host, port, token, key_b64, ready), daemon=True)
    t.start()
    ready.wait(timeout=2)
    # Write ipc_info.json where service expects it (enc_dir/key.fernet.ipc.json)
    ipc_path = (enc_dir / 'key.fernet.ipc.json')
    ipc_path.write_text(json.dumps({'host': host, 'port': port, 'token': token}))
    # Build service pointing to tmp_path as base of encrypted dir
    svc = CaptureService(output_dir=tmp_path / 'plain', enc_dir=enc_dir)
    # Service should have read _key from IPC (base64 decodes to dummy_key)
    assert svc._key == dummy_key