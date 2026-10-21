import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location("confined", Path(__file__).resolve().parents[1] / "guest/supervisor/confined_fs.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

@unittest.skipUnless(os.name == "posix", "Linux dirfd/O_NOFOLLOW required")
class ConfinedFilesystemTests(unittest.TestCase):
    def test_files_roundtrip_and_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            fs = m.ConfinedFS(temp)
            fs.call("write", {"path": "dir/file", "content": "marker"})
            self.assertEqual(fs.call("read", {"path": "dir/file"})["content"], "marker")
            for path in ["../escape", "/etc/passwd", "dir/../../escape"]:
                with self.assertRaises(ValueError): fs.call("read", {"path": path})
            fs.call("delete", {"path": "dir"})
            self.assertEqual(fs.call("list", {})["entries"], [])

    def test_symlink_and_hardlink_writes_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); home = root / "home"; home.mkdir()
            outside = root / "outside"; outside.mkdir(); (outside / "marker").write_text("retain")
            (home / "escape").symlink_to(outside, target_is_directory=True)
            (home / "file-link").symlink_to(outside / "marker")
            os.link(outside / "marker", home / "hardlink")
            fs = m.ConfinedFS(str(home))
            for path in ["escape/marker", "file-link", "hardlink"]:
                with self.assertRaises((OSError, ValueError)): fs.call("write", {"path": path, "content": "attack"})
            self.assertEqual((outside / "marker").read_text(), "retain")
            fs.call("delete", {"path": "escape"})
            self.assertEqual((outside / "marker").read_text(), "retain")

    def test_oversize_write_does_not_truncate_existing_file(self):
        with tempfile.TemporaryDirectory() as temp:
            fs = m.ConfinedFS(temp); fs.call("write", {"path": "file", "content": "retain"})
            with self.assertRaises(ValueError): fs.call("write", {"path": "file", "content": "x" * 5_000_001})
            self.assertEqual(fs.call("read", {"path": "file"})["content"], "retain")

if __name__ == "__main__": unittest.main()
