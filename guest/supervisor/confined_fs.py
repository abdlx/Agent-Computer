"""Linux dirfd filesystem access: no path component is followed through a symlink."""
import base64
import os
from pathlib import PurePosixPath
import stat

class ConfinedFS:
    def __init__(self, home):
        self.home = os.path.abspath(home)

    def parts(self, raw):
        raw = str(raw or ".")
        if raw.startswith("/"):
            if raw != self.home and not raw.startswith(self.home + "/"):
                raise ValueError("path is outside the home directory")
            raw = raw[len(self.home):].lstrip("/")
        parts = PurePosixPath(raw).parts
        if ".." in parts or "\x00" in raw:
            raise ValueError("unsafe filesystem path")
        return [p for p in parts if p != "."]

    def parent(self, parts, create=False):
        fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts:
                if create:
                    try: os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError: pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            return fd
        except BaseException as error:
            os.close(fd)
            if isinstance(error, OSError) and error.errno in (20, 40):
                raise ValueError("symlink or non-directory path refused") from error
            raise

    def remove_tree(self, parent, name):
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                for child in os.listdir(fd): self.remove_tree(fd, child)
            finally: os.close(fd)
            os.rmdir(name, dir_fd=parent)
        else: os.unlink(name, dir_fd=parent)

    def call(self, operation, body):
        parts = self.parts(body.get("path", "."))
        if operation == "list":
            fd = self.parent(parts)
            try:
                entries = []
                for name in sorted(os.listdir(fd)):
                    item = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    entries.append({"name": name, "dir": stat.S_ISDIR(item.st_mode), "size": item.st_size})
                return {"entries": entries}
            finally: os.close(fd)
        if operation == "mkdir":
            fd = self.parent(parts, True); os.close(fd)
            return {"path": "/".join(parts)}
        if not parts: raise ValueError("operation on home root is forbidden")
        parent = self.parent(parts[:-1], operation == "write")
        try:
            name = parts[-1]
            if operation == "delete":
                self.remove_tree(parent, name)
                return {"deleted": "/".join(parts)}
            if operation not in ("read", "write"): raise ValueError("unknown filesystem operation")
            flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_RDONLY if operation == "read" else os.O_WRONLY | os.O_CREAT)
            fd = os.open(name, flags, 0o600, dir_fd=parent)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("filesystem operations require a regular, singly linked file")
                if operation == "read":
                    with os.fdopen(os.dup(fd), "rb") as stream: data = stream.read(262144)
                    try: return {"encoding": "utf-8", "content": data.decode("utf-8")}
                    except UnicodeDecodeError: return {"encoding": "base64", "content": base64.b64encode(data).decode()}
                data = (base64.b64decode(str(body.get("content", "")), validate=True) if body.get("encoding") == "base64" else str(body.get("content", "")).encode())
                if len(data) > 5_000_000: raise ValueError("file too large (5 MB max per write)")
                os.ftruncate(fd, 0)
                with os.fdopen(os.dup(fd), "wb") as stream: stream.write(data)
                return {"path": "/".join(parts), "bytes": len(data)}
            finally: os.close(fd)
        except OSError as error:
            if error.errno in (20, 40): raise ValueError("symlink or non-directory path refused") from error
            raise
        finally: os.close(parent)
