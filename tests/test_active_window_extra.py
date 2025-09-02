import types
import sys
from pathlib import Path

import capture.active_window as aw


def make_fake_sct(size=(10, 10), rgb=b'\x00' * 300):
    class FakeGrab:
        def __init__(self, size, rgb):
            self.size = size
            self.rgb = rgb

    class FakeSCT:
        def __init__(self, size, rgb):
            self._size = size
            self._rgb = rgb

        def grab(self, region):
            return FakeGrab(self._size, self._rgb)

        @property
        def monitors(self):
            return [{"left": 0, "top": 0, "width": self._size[0], "height": self._size[1]}]

    return FakeSCT(size, rgb)


def test_capture_region_mss_success(tmp_path, monkeypatch):
    out = tmp_path / "out.png"
    # Ensure mss is available and _get_mss returns a fake sct
    monkeypatch.setattr(aw, "mss", True)
    monkeypatch.setattr(aw, "_get_mss", lambda: make_fake_sct((4, 4), b'\x00' * (4 * 4 * 3)))

    # Inject a fake PIL + PIL.Image module so that 'from PIL import Image' works.
    import types as _types
    fake_pil = _types.ModuleType('PIL')
    fake_pil.__path__ = []  # mark as package so submodule import path works
    fake_image = _types.ModuleType('PIL.Image')

    def _frombytes(mode, size, data):  # mimic Pillow Image.frombytes
        class Img:
            def save(self, path, format=None):  # noqa: D401
                Path(path).write_bytes(b"PNG")
        return Img()

    fake_image.frombytes = _frombytes  # type: ignore[attr-defined]
    # Provide attribute so 'from PIL import Image' finds it directly without needing real pkg structure.
    fake_pil.Image = fake_image  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, 'PIL', fake_pil)
    monkeypatch.setitem(sys.modules, 'PIL.Image', fake_image)

    aw.capture_region((0, 0, 4, 4), str(out))
    assert out.exists()


def test_capture_region_mss_failure_then_imagegrab(monkeypatch, tmp_path):
    out = tmp_path / "out2.png"
    # Simulate _get_mss raising ScreenShotError twice then ImageGrab succeeds
    class FakeError(Exception):
        pass

    def bad_get_mss():
        raise aw.ScreenShotError("boom")

    monkeypatch.setattr(aw, "_get_mss", bad_get_mss)

    # Provide PIL.ImageGrab.grab that returns an object with save
    import types as _types
    fake_pil = _types.ModuleType('PIL')

    class FakeGrabImg:
        def save(self, path, format=None):
            Path(path).write_text("OK")

    fake_pil.ImageGrab = types.SimpleNamespace(grab=lambda bbox=None: FakeGrabImg())  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, 'PIL', fake_pil)

    # Run capture_region which should fallback to ImageGrab after mss failures
    aw._DISPLAY_FAILURES = 2
    aw.capture_region((0, 0, 2, 2), str(out))
    assert out.exists()


def test_capture_region_both_fail(monkeypatch):
    # Simulate both mss and ImageGrab failing -> RuntimeError
    def bad_get_mss():
        raise aw.ScreenShotError("mss fail")

    monkeypatch.setattr(aw, "_get_mss", bad_get_mss)

    import types as _types
    fake_pil = _types.ModuleType('PIL')
    fake_pil.ImageGrab = types.SimpleNamespace(grab=lambda bbox=None: (_ for _ in ()).throw(RuntimeError("grab fail")))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, 'PIL', fake_pil)

    try:
        aw.capture_region((0, 0, 1, 1), "/tmp/should-not-exist.png")
        assert False, "Expected RuntimeError"
    except RuntimeError:
        pass
