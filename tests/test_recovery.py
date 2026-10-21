import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("recovery", Path(__file__).resolve().parents[1] / "ops/recovery.py")
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)

class RecoveryTests(unittest.TestCase):
    def archive(self, root, members):
        path = Path(root) / "input.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, kind, target in members:
                entry = tarfile.TarInfo(name)
                if kind == "file":
                    entry.size = len(target); archive.addfile(entry, io.BytesIO(target))
                else:
                    entry.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "device": tarfile.CHRTYPE}[kind]
                    entry.linkname = target; archive.addfile(entry)
        return path

    def test_traversal_absolute_windows_and_duplicate_paths(self):
        for name in ["../escape", "/etc/shadow", "C:/escape", "a/../../escape", "a//b", "a/./b"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                path = self.archive(temp, [(name, "file", b"bad")])
                with self.assertRaises(ValueError), tarfile.open(path, "r:gz") as archive:
                    r.validate_members(archive)
        with tempfile.TemporaryDirectory() as temp:
            path = self.archive(temp, [("same", "file", b"1"), ("same", "file", b"2")])
            with self.assertRaises(ValueError), tarfile.open(path, "r:gz") as archive:
                r.validate_members(archive)

    def test_link_escape_and_special_files(self):
        cases = [[("link", "symlink", "/tmp/outside"), ("link/escape", "file", b"x")],
                 [("link", "hardlink", "../escape")], [("dev", "device", "")]]
        for case in cases:
            with tempfile.TemporaryDirectory() as temp:
                path = self.archive(temp, case)
                with self.assertRaises(ValueError), tarfile.open(path, "r:gz") as archive:
                    r.validate_members(archive)

    def test_size_limit_and_existing_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            path = self.archive(temp, [("file", "file", b"12345")])
            with self.assertRaises(ValueError), tarfile.open(path, "r:gz") as archive:
                r.validate_members(archive, 4)
            destination = Path(temp) / "existing"; destination.mkdir(); (destination / "old").write_text("retain")
            with self.assertRaises(ValueError): r.extract(path, destination)
            self.assertEqual((destination / "old").read_text(), "retain")

    def test_snapshot_contains_registry_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); cp = root / "cp"; sup = root / "sup"; home = root / "home"
            for d in [cp, sup, home]: d.mkdir()
            (cp / "control-plane.db").write_bytes(b"db-example")
            (sup / "registry.json").write_text('{"box":{"containerId":"exact-id"}}')
            (home / "marker").write_text("before")
            volumes = [("control-plane", "cp-volume", cp), ("supervisor", "sup-volume", sup), ("home", "home-volume", home)]
            r.snapshot(volumes, root / "backup"); manifest = r.verify(root / "backup")
            (home / "marker").write_text("after")
            r.apply(root / "backup", manifest, volumes)
            self.assertEqual((home / "marker").read_text(), "before")
            self.assertEqual(json.loads((sup / "registry.json").read_text())["box"]["containerId"], "exact-id")
            artifact = root / "backup" / manifest["volumes"][0]["file"]
            artifact.write_bytes(artifact.read_bytes() + b"corrupt")
            with self.assertRaisesRegex(ValueError, "checksum/size"): r.verify(root / "backup")

    def test_inventory_mismatch_never_mutates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "marker").write_text("retain")
            with self.assertRaises(ValueError): r.apply(root, {"volumes": [{"volume": "foreign"}]}, [("home", "ours", root)])
            self.assertEqual((root / "marker").read_text(), "retain")

if __name__ == "__main__": unittest.main()
