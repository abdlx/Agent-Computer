import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location("human_input", Path(__file__).resolve().parents[1] / "guest/supervisor/human_input.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def frame(payload, opcode=2):
    mask = bytes([1,2,3,4])
    return bytes([128 | opcode, 128 | len(payload)]) + mask + bytes(v ^ mask[i % 4] for i,v in enumerate(payload))

class HumanInputTests(unittest.TestCase):
    def setup_observer(self):
        events = []; observer = m.HumanInputObserver(lambda: events.append("human"))
        observer.feed(frame(b"RFB 003.008\n")); observer.feed(frame(bytes([1]))); observer.feed(frame(bytes([1])))
        self.assertEqual(events, [])
        return observer, events
    def test_partial_websocket_frame(self):
        observer, events = self.setup_observer()
        payload = frame(bytes([5,0,0,10,0,20]))
        observer.feed(payload[:4]); self.assertEqual(events, [])
        observer.feed(payload[4:]); self.assertEqual(events, ["human"])
    def test_coalesced_rfb_and_fragmented_input(self):
        observer, events = self.setup_observer()
        observer.feed(frame(bytes([3])+bytes(9)+bytes([4,1,0,0])))
        self.assertEqual(events, [])
        observer.feed(frame(bytes([0,0,0,65]), opcode=0))
        self.assertEqual(events, ["human"])
    def test_periodic_framebuffer_request_is_not_takeover(self):
        observer, events = self.setup_observer()
        observer.feed(frame(bytes([3])+bytes(9)))
        self.assertEqual(events, [])

if __name__ == "__main__": unittest.main()
