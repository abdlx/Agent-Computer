"""Observe browser-to-VNC WebSocket input without altering its byte stream."""
class HumanInputObserver:
    def __init__(self, takeover):
        self.buffer = bytearray()
        self.takeover = takeover
        self.rfb = bytearray()
        self.phase = "version"

    def feed(self, chunk):
        self.buffer.extend(chunk)
        while len(self.buffer) >= 2:
            first, second = self.buffer[0], self.buffer[1]
            size = second & 127
            position = 2
            if size == 126:
                if len(self.buffer) < 4: return
                size = int.from_bytes(self.buffer[2:4], "big"); position = 4
            elif size == 127:
                if len(self.buffer) < 10: return
                size = int.from_bytes(self.buffer[2:10], "big"); position = 10
            masked = bool(second & 128)
            if size > 1_000_000:
                self.buffer.clear(); return
            end = position + (4 if masked else 0) + size
            if len(self.buffer) < end: return
            mask = self.buffer[position:position + 4] if masked else None
            data = bytes(self.buffer[position + (4 if masked else 0):end])
            del self.buffer[:end]
            if mask: data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
            if first & 15 in (0, 2):
                self.inspect_rfb(data)

    def inspect_rfb(self, data):
        self.rfb.extend(data)
        while self.rfb:
            if self.phase == "version":
                if len(self.rfb) < 12: return
                del self.rfb[:12]; self.phase = "security"
            elif self.phase in ("security", "init"):
                del self.rfb[:1]
                self.phase = "init" if self.phase == "security" else "normal"
            else:
                kind = self.rfb[0]
                length = {0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 255: 12}.get(kind)
                if kind == 2:
                    if len(self.rfb) < 4: return
                    length = 4 + int.from_bytes(self.rfb[2:4], "big") * 4
                elif kind == 6:
                    if len(self.rfb) < 8: return
                    length = 8 + int.from_bytes(self.rfb[4:8], "big")
                elif kind == 248:
                    if len(self.rfb) < 9: return
                    length = 9 + self.rfb[8]
                elif kind == 251:
                    if len(self.rfb) < 8: return
                    length = 8 + self.rfb[6] * 16
                if length is None or length > 1_000_000:
                    self.rfb.clear(); self.takeover(); return
                if len(self.rfb) < length: return
                del self.rfb[:length]
                if kind in (4, 5, 6, 255): self.takeover()
