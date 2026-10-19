"""Tests for the independent checker. Run: python -m unittest tools/test_verify_witness.py"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import verify_witness as vw  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"


class VerifyWitnessTest(unittest.TestCase):
    def test_ed25519_with_beacon(self):
        ok, checks, summary = vw.verify(str(FIX / "ed25519.voxpop"), skip_beacons=False)
        self.assertTrue(ok, checks)
        self.assertEqual(summary["sealed"], "sealed")
        self.assertEqual(summary["earliestProvenTime"], "2023-09-27T08:29:24Z")

    def test_ecdsa(self):
        ok, checks, _ = vw.verify(str(FIX / "ecdsa-p256.voxpop"), skip_beacons=False)
        self.assertTrue(ok, checks)

    def test_tampered(self):
        ok, checks, _ = vw.verify(str(FIX / "tampered.voxpop"), skip_beacons=True)
        self.assertFalse(ok)
        self.assertIn("modified after signing", checks[-1]["detail"])

    def test_canonical_matches_app(self):
        self.assertEqual(vw.canonical({"b": 1, "a": [True, None, "x"]}), b'{"a":[true,null,"x"],"b":1}')

    def test_real_beacon(self):
        b = {"round": 1000000, "randomness": "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
             "signature": "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72"}
        self.assertTrue(vw.verify_beacon(b))
        self.assertFalse(vw.verify_beacon({**b, "round": 1000001}))


if __name__ == "__main__":
    unittest.main()
